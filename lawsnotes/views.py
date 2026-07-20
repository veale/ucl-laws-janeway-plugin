__copyright__ = "Copyright 2026"
__author__ = "UCL Laws"
__license__ = "AGPL v3"

import functools
import os
import re
import uuid

from django.conf import settings as django_settings
from django.contrib import messages
from django.http import JsonResponse
from django.shortcuts import redirect, render
from django.urls import reverse

from security.decorators import editor_user_required, base_check_required

from utils.setting_handler import get_plugin_setting, save_plugin_setting

from journal import models as journal_models
from submission import models as submission_models

from plugins.lawsnotes import plugin_settings


def lawsnotes_manage_access_required(view):
    """Custom access check for the UCL Laws manage page.

    Always allows: superusers, journal managers, journal editors,
    section editors -- the same audience editor_user_required covers.

    Additionally allows: anyone holding a journal-role listed in the
    per-journal `extra_access_roles` plugin setting (comma-separated
    role short-names, e.g. 'production-manager,copyeditor'). This is
    the delegation surface: a journal manager can grant additional
    staff access to the customisation page without sysadmin
    intervention. The set of available role short-names is whatever
    Janeway's AccountRole table records for the journal -- typically
    a subset of {editor, manager, section-editor, production-manager,
    copyeditor, typesetter, proofreader, reviewer, author}.

    When `extra_access_roles` is empty or unset, behaviour is
    identical to plain editor_user_required."""

    @functools.wraps(view)
    @base_check_required
    def wrapped(request, *args, **kwargs):
        user = request.user
        journal = getattr(request, "journal", None)

        # Same audience as editor_user_required: editors, staff,
        # journal-managers.
        if user.is_staff or user.is_editor(request) or (
            journal and user.is_journal_manager(journal)
        ):
            return view(request, *args, **kwargs)

        # Delegated extra roles: read the per-journal Setting,
        # split + lowercase the configured short-names, and accept
        # the request if the user holds any of them on this journal.
        if journal:
            try:
                sv = get_plugin_setting(
                    plugin_settings.get_self(),
                    "extra_access_roles",
                    journal,
                )
                raw = (sv.processed_value or "") if sv else ""
            except Exception:
                raw = ""
            allowed = {
                r.strip().lower() for r in raw.split(",") if r.strip()
            }
            if allowed:
                user_roles = {
                    (r.role.slug or "").lower()
                    for r in user.accountrole_set.filter(journal=journal)
                }
                if allowed & user_roles:
                    return view(request, *args, **kwargs)

        # Otherwise, fall through to the standard editor_user_required
        # rejection (renders Janeway's deny_access page).
        from security.decorators import deny_access
        deny_access(request)

    return wrapped


_ALLOWED_FONT_EXTS = {".woff2", ".woff", ".ttf", ".otf", ".eot"}


def _font_upload_dir(journal):
    """Per-journal directory under MEDIA_ROOT for uploaded font files."""
    return os.path.join(
        django_settings.MEDIA_ROOT, "lawsnotes", journal.code, "fonts",
    )


def _font_upload_url(journal, filename):
    """Public URL the browser uses to fetch the uploaded font file."""
    base = django_settings.MEDIA_URL.rstrip("/")
    return "{0}/lawsnotes/{1}/fonts/{2}".format(base, journal.code, filename)


def _save_uploaded_font(uploaded, journal):
    """Stream `uploaded` (an InMemoryUploadedFile) to disk under the
    journal's MEDIA_ROOT directory and return the public URL.
    Filenames are uuid-prefixed to dodge collisions and to make
    each upload cache-bustable."""
    name = os.path.basename(uploaded.name or "")
    ext = os.path.splitext(name)[1].lower()
    if ext not in _ALLOWED_FONT_EXTS:
        raise ValueError(
            "Font file must be one of {0}.".format(
                ", ".join(sorted(_ALLOWED_FONT_EXTS))
            )
        )
    target_dir = _font_upload_dir(journal)
    os.makedirs(target_dir, exist_ok=True)
    fname = "{0}-{1}".format(uuid.uuid4().hex[:8], name.replace(" ", "_"))
    path = os.path.join(target_dir, fname)
    with open(path, "wb") as fh:
        for chunk in uploaded.chunks():
            fh.write(chunk)
    return _font_upload_url(journal, fname)


_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


def _plain_abstract(html, max_chars=340):
    """Strip tags + collapse whitespace + truncate to a card-sized line."""
    text = _TAG_RE.sub(" ", html or "")
    text = _WS_RE.sub(" ", text).strip()
    if len(text) > max_chars:
        # back off to last whitespace before max_chars + ellipsis
        text = text[:max_chars].rsplit(" ", 1)[0] + "…"
    return text


@lawsnotes_manage_access_required
def manage(request):
    """Per-journal manage page reachable from `/plugins/lawsnotes/manager/`
    (the link shown as "Manage" against this plugin in the journal's
    Plugins list).

    GET renders a sectioned form covering every entry in
    plugin_settings.CUSTOMISATION_SETTINGS plus the master enabled
    toggle. POST writes each field back as a SettingValue and, if a
    font file was uploaded, stores the file under MEDIA_ROOT and
    auto-fills the corresponding `uploaded_font_N_url` setting.

    Rendered effects propagate on the very next request -- no
    restart, no asset rebuild. This is the editor's escape hatch
    for everything from quick colour tweaks to ad-hoc CSS / JS
    patches that fix issues the host hasn't redeployed for yet."""
    plugin = plugin_settings.get_self()
    journal = getattr(request, "journal", None)

    if not journal:
        messages.error(
            request,
            "UCL Laws is configured per journal — open this from a journal context.",
        )
        return redirect("core_manager_index")

    if request.method == "POST":
        # 1. Master enable/disable toggle.
        new_value = request.POST.get(plugin_settings.SETTING_NAME) == "on"
        save_plugin_setting(
            plugin, plugin_settings.SETTING_NAME, new_value, journal,
        )

        # 2. Customisation fields. Booleans are checkboxes (present =
        #    on, absent = off). Strings/text fields take whatever the
        #    user entered. Empty strings are saved as-is so editors
        #    can clear an override and fall back to the default.
        for spec in plugin_settings.CUSTOMISATION_SETTINGS:
            name = spec["name"]
            if spec["type"] == "boolean":
                value = "on" if request.POST.get(name) == "on" else ""
            else:
                value = request.POST.get(name, "")
            save_plugin_setting(plugin, name, value, journal)

        # 3. Optional font uploads (up to 3). For each slot we accept
        #    an upload + a free-text family-name field; if the upload
        #    is present we save the file and overwrite the slot's
        #    `_url` setting. Family-name was already written above.
        for n in (1, 2, 3):
            f = request.FILES.get("uploaded_font_{0}_file".format(n))
            if not f:
                continue
            try:
                url = _save_uploaded_font(f, journal)
            except ValueError as e:
                messages.error(request, "Font #{0}: {1}".format(n, e))
                continue
            save_plugin_setting(
                plugin, "uploaded_font_{0}_url".format(n), url, journal,
            )
            messages.success(
                request,
                "Font #{0} uploaded to {1}.".format(n, url),
            )

        messages.success(request, "UCL Laws settings saved for {0}.".format(
            journal.code,
        ))
        return redirect(reverse(plugin_settings.MANAGER_URL))

    sv = get_plugin_setting(plugin, plugin_settings.SETTING_NAME, journal)
    cust = plugin_settings.get_customisation(journal)

    # Build a list of {section_id, section_label, fields[]} groups so
    # the template just iterates without needing logic.
    sections = []
    for section_id, section_label in plugin_settings.CUSTOMISATION_SECTIONS:
        fields = []
        for spec in plugin_settings.CUSTOMISATION_SETTINGS:
            if spec.get("section") != section_id:
                continue
            entry = dict(spec)
            entry["value"] = cust.get(spec["name"], spec["default"])
            fields.append(entry)
        if fields:
            sections.append({
                "id": section_id,
                "label": section_label,
                "fields": fields,
            })

    return render(
        request,
        "lawsnotes/manage.html",
        {
            "plugin": plugin,
            "plugin_settings": plugin_settings,
            "enabled": bool(sv and sv.processed_value),
            "sections": sections,
        },
    )


@editor_user_required
def configure_latest_articles(request):
    """Configure page for the Latest Articles homepage element.
    Reachable from the homepage manager's Configure link. One field:
    how many articles to show. Persisted as the per-journal
    `latest_articles_count` setting; the hook reads it on each
    homepage render."""
    plugin = plugin_settings.get_self()
    journal = getattr(request, "journal", None)
    if not journal:
        messages.error(
            request,
            "Open Configure from a journal context.",
        )
        return redirect("core_manager_index")

    if request.method == "POST":
        raw = request.POST.get("count", str(plugin_settings.LATEST_COUNT_DEFAULT))
        try:
            count = int(raw)
        except (TypeError, ValueError):
            count = plugin_settings.LATEST_COUNT_DEFAULT
        count = max(1, min(50, count))
        save_plugin_setting(
            plugin, plugin_settings.LATEST_COUNT_SETTING, str(count), journal,
        )
        messages.success(
            request,
            "Latest Articles will show {} item{}.".format(
                count, "" if count == 1 else "s",
            ),
        )
        return redirect("home_settings_index")

    sv = get_plugin_setting(
        plugin, plugin_settings.LATEST_COUNT_SETTING, journal,
    )
    current = (
        sv.processed_value if sv and sv.processed_value
        else plugin_settings.LATEST_COUNT_DEFAULT
    )
    return render(
        request,
        "lawsnotes/configure_latest.html",
        {
            "plugin_settings": plugin_settings,
            "current": current,
        },
    )


def card_metadata(request):
    """JSON endpoint replacing the per-card HTML scraping the JS used
    to do. One request, ~1 KB out instead of N x ~80 KB.

    Query parameters (both optional):
      ?articles=7,8,9   -> abstracts for those article IDs
      ?issues=1,2,3     -> deduped author surnames for each issue

    Response:
      { "articles": {"7": {"abstract": "..."}, ...},
        "issues":   {"1": {"surnames": ["Whittaker", "Desai", ...]}, ...} }

    Scoped to request.journal so cross-journal IDs can't leak."""
    journal = getattr(request, "journal", None)
    if not plugin_settings.is_enabled_for(journal):
        return JsonResponse({"articles": {}, "issues": {}})

    def _ids(name):
        return [int(x) for x in request.GET.get(name, "").split(",") if x.isdigit()]

    out = {"articles": {}, "issues": {}}

    for art in submission_models.Article.objects.filter(
        pk__in=_ids("articles"), journal=journal,
    ).only("id", "abstract"):
        out["articles"][str(art.pk)] = {"abstract": _plain_abstract(art.abstract)}

    for issue in journal_models.Issue.objects.filter(
        pk__in=_ids("issues"), journal=journal,
    ).prefetch_related("articles__frozenauthor_set"):
        seen, names = set(), []
        for art in issue.articles.all():
            for fa in art.frozenauthor_set.all():
                ln = (fa.last_name or "").strip()
                if ln and ln not in seen:
                    seen.add(ln)
                    names.append(ln)
        out["issues"][str(issue.pk)] = {"surnames": names}

    return JsonResponse(out)
