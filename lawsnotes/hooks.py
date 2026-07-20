__copyright__ = "Copyright 2026"
__author__ = "UCL Laws"
__license__ = "AGPL v3"

import json

from django.templatetags.static import static
from django.urls import reverse, NoReverseMatch
from django.utils.safestring import mark_safe

from utils.setting_handler import get_plugin_setting
from plugins.lawsnotes import plugin_settings


def _is_target_journal(context):
    """True iff the request's journal has the plugin enabled. Wraps
    plugin_settings.is_enabled_for() with the template-context-shaped
    request lookup."""
    request = context.get("request") if context else None
    journal = getattr(request, "journal", None) if request else None
    return plugin_settings.is_enabled_for(journal)


_FONT_FORMAT_BY_EXT = {
    ".woff2": "woff2",
    ".woff": "woff",
    ".ttf": "truetype",
    ".otf": "opentype",
    ".eot": "embedded-opentype",
}


def _build_fontface_block(cust):
    """Emit one @font-face block per filled-in `uploaded_font_N_url`
    + `uploaded_font_N_family` pair. Editors then reference the
    family name from font_body / font_heading / custom_css."""
    blocks = []
    for n in (1, 2, 3):
        url = (cust.get("uploaded_font_{0}_url".format(n)) or "").strip()
        family = (cust.get("uploaded_font_{0}_family".format(n)) or "").strip()
        if not url or not family:
            continue
        ext = ""
        for e in _FONT_FORMAT_BY_EXT:
            if url.lower().endswith(e):
                ext = e
                break
        fmt = _FONT_FORMAT_BY_EXT.get(ext, "")
        src = "url('{0}')".format(_css_value(url))
        if fmt:
            src += " format('{0}')".format(fmt)
        blocks.append(
            "@font-face {{ font-family: '{family}'; "
            "src: {src}; font-display: swap; }}".format(
                family=_css_value(family).replace("'", ""),
                src=src,
            )
        )
    return "\n".join(blocks)


def _build_variables_block(cust):
    """Build a `:root { --lawsnotes-*: ...; }` block from per-journal
    customisation values. Each entry in CUSTOMISATION_SETTINGS that
    declares a `css_var` becomes one custom property. A spec can
    optionally provide a `css_format` template (e.g. `url("{0}")`)
    to wrap the raw value before it lands in the declaration."""
    decls = []
    for spec in plugin_settings.CUSTOMISATION_SETTINGS:
        var = spec.get("css_var")
        if not var:
            continue
        val = cust.get(spec["name"])
        if not isinstance(val, str) or not val.strip():
            continue
        clean = _css_value(val)
        fmt = spec.get("css_format")
        if fmt:
            clean = fmt.format(clean)
        decls.append("    {0}: {1};".format(var, clean))
    if not decls:
        return ""
    return ":root {\n" + "\n".join(decls) + "\n}\n"


def _css_value(v):
    """Defensive: refuse strings that try to escape the property
    declaration (no `;`, `{`, `}`, `</style`). Editors are trusted
    to set sane values, but the field is free-form so we still
    defend the surrounding stylesheet from accidents."""
    if not isinstance(v, str):
        return ""
    bad = (";", "{", "}", "</")
    for token in bad:
        if token in v.lower():
            v = v.replace(token, "")
    return v.strip()


def _settings_js(cust):
    """Serialise behavioural toggles + numeric layout values into a
    `window.lawsnotesSettings` global so the runtime JS doesn't have to
    re-read CSS variables (which it can't easily for things like the
    sidenote breakpoint, computed before any layout)."""
    payload = {
        "showDropCaps": bool(cust.get("show_drop_caps")),
        "hideCiteDropdown": bool(cust.get("hide_cite_dropdown")),
        "hideEndnoteListWhenSidenotes": bool(
            cust.get("hide_endnote_list_when_sidenotes")
        ),
        "sidenoteBreakpoint": _safe_int(cust.get("sidenote_breakpoint"), 1280),
        "sidenoteWidth": _safe_int(cust.get("sidenote_width"), 220),
        "logoUrl": cust.get("logo_url") or "",
    }
    return json.dumps(payload)


def _safe_int(val, default):
    """Parse an editor-entered length like "1280" or "1280px" to an int.

    Note this strips a trailing "px" as a unit suffix only -- rstrip("px")
    would chew any trailing p/x characters, so "800xp" and "100px" would
    both parse where only the latter should.
    """
    text = str(val).strip()
    if text.endswith("px"):
        text = text[:-2].strip()
    try:
        return int(text)
    except (TypeError, ValueError):
        return default


def head_css(context, *args, **kwargs):
    """Hook: base_head_css. Fires inside <head> on EVERY page that
    extends OLH's core/base.html. We piggyback our JS onto this hook
    too (with defer) because OLH base.html doesn't expose an every-
    page JS hook -- only the article template fires article_js_block.
    Loading from <head> with defer is equivalent to a body-end script
    tag in execution order, so DOMContentLoaded handlers still work.

    We also stamp the journal name onto window.lawsnotesJournalName so the
    JS can read it without parsing <title> (which has different
    formats per page) or relying on header markup that varies.

    Per-journal customisations (colours, fonts, logo URL, layout
    dimensions, custom CSS) are read from the SETTING_GROUP_NAME group
    and emitted as a `:root { --lawsnotes-*: ...; }` block + an optional
    free-form stylesheet trailer, after lawsnotes.css so they win on
    specificity. Editors edit these from the manage page; effects
    propagate on the next request without code changes or restarts."""
    if not _is_target_journal(context):
        return ""
    request = context.get("request") if context else None
    journal = getattr(request, "journal", None) if request else None
    journal_name = (journal.name if journal else "") or ""
    name_js = json.dumps(journal_name)
    try:
        api_url_js = json.dumps(reverse("lawsnotes_api_cards"))
    except NoReverseMatch:
        api_url_js = "null"

    cust = plugin_settings.get_customisation(journal)
    variables_block = _build_variables_block(cust)
    fontface_block = _build_fontface_block(cust)
    settings_js = _settings_js(cust)

    parts = []
    # Optional editor-supplied webfont stylesheet (e.g. Google Fonts).
    extra_url = (cust.get("font_extra_css_url") or "").strip()
    if extra_url and extra_url.startswith(("http://", "https://", "/")):
        parts.append('<link href="{0}" rel="stylesheet">'.format(
            _css_value(extra_url)
        ))
    parts.append('<link href="{0}" rel="stylesheet">'.format(
        static("lawsnotes/lawsnotes.css")
    ))
    if fontface_block:
        # @font-face declarations for editor-uploaded woff2/woff/ttf
        # files. Emitted BEFORE the variables block so the
        # font-family names are registered by the time anything
        # downstream tries to use them.
        parts.append("<style>{0}</style>".format(fontface_block))
    if variables_block:
        parts.append("<style>{0}</style>".format(variables_block))
    # Free-form CSS override (last so it wins over everything above).
    custom_css = (cust.get("custom_css") or "").strip()
    if custom_css:
        # Strip the obvious style-injection escape; everything else
        # is allowed because editors are trusted within this surface.
        safe_css = custom_css.replace("</style", "")
        parts.append("<style>{0}</style>".format(safe_css))
    parts.append(
        '<script>window.lawsnotesJournalName = {name_js};'
        'window.lawsnotesApiUrl = {api_url};'
        'window.lawsnotesSettings = {settings};</script>'.format(
            name_js=name_js,
            api_url=api_url_js,
            settings=settings_js,
        )
    )
    parts.append('<script src="{0}" defer></script>'.format(
        static("lawsnotes/lawsnotes.js")
    ))
    # Optional editor-supplied external JS (deferred, loaded after lawsnotes.js).
    custom_js_url = (cust.get("custom_js_url") or "").strip()
    if custom_js_url and custom_js_url.startswith(("http://", "https://", "/")):
        parts.append('<script src="{0}" defer></script>'.format(
            _css_value(custom_js_url)
        ))
    # Inline editor-supplied JS, wrapped in a try/catch so a syntax
    # error or runtime exception in the snippet doesn't break the
    # page. Loaded with defer + after lawsnotes.js so window.lawsnotesOnReady
    # and the rest of the public surface are guaranteed available.
    custom_js = (cust.get("custom_js") or "").strip()
    if custom_js:
        safe_js = custom_js.replace("</script", "<\\/script")
        # No .format() here -- the embedded JS uses { and } literals
        # which conflict with str.format escaping; concatenation is
        # cleaner and safer.
        parts.append(
            '<script defer>'
            'document.addEventListener("DOMContentLoaded", function () {'
            '  try { (function(){\n'
            + safe_js +
            '\n})(); } catch (e) {'
            ' console.error("[lawsnotes custom_js]", e); '
            '} });'
            '</script>'
        )
    return mark_safe("\n".join(parts))


def latest_articles_context(request, homepage_elements):
    """Hook: yield_homepage_element_context. Fires when our
    HomepageElement is active on a journal AND the plugin's per-journal
    `enabled` setting is on -- so flipping the plugin off in the
    manager UI silences this even if the editor hasn't separately
    deactivated the homepage element."""
    if not homepage_elements:
        return {}
    if not homepage_elements.filter(name=plugin_settings.HOMEPAGE_ELEMENT_NAME).exists():
        return {}
    journal = getattr(request, "journal", None)
    if not plugin_settings.is_enabled_for(journal):
        return {}

    from django.utils import timezone
    from submission import models as submission_models

    # Read the per-journal configured count; clamp to a sane range.
    count = plugin_settings.LATEST_COUNT_DEFAULT
    plugin = plugin_settings.get_self()
    if plugin:
        try:
            sv = get_plugin_setting(
                plugin, plugin_settings.LATEST_COUNT_SETTING, journal,
            )
            if sv and sv.processed_value:
                count = int(sv.processed_value)
        except (Exception,):
            pass
    count = max(1, min(50, count))

    qs = (
        submission_models.Article.objects
        .filter(
            journal=journal,
            stage=submission_models.STAGE_PUBLISHED,
            date_published__lte=timezone.now(),
        )
        .order_by("-date_published")
        .prefetch_related("frozenauthor_set")[:count]
    )
    return {"lawsnotes_latest_articles": list(qs)}
