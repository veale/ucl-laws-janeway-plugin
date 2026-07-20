__copyright__ = "Copyright 2026"
__author__ = "UCL Laws"
__license__ = "AGPL v3"

from django.core.cache import cache
from django.db.utils import OperationalError

from utils import models
from utils.logger import get_logger

logger = get_logger(__name__)

# How long per-journal settings are cached. Saves through the manage page
# invalidate explicitly, so this only bounds staleness for changes made
# out-of-band (shell, Django admin, fixtures).
CUSTOMISATION_CACHE_TTL = 300

PLUGIN_NAME = "lawsnotes"
DISPLAY_NAME = "UCL Laws"
DESCRIPTION = (
    "Law-journal styling and sidenote rendering for the UCL Laws journal. "
    "Ships its own typography (Newsreader webfont), Tufte-style "
    "alternating sidenotes, rollover note popovers on narrow viewports, "
    "an OSCOLA citation shape, and a minimalist single-paper layout. "
    "Journal-scoped via ENABLED_JOURNAL_CODES below; other journals on "
    "the press install are unaffected."
)
AUTHOR = "UCL Laws"
VERSION = "0.1"

# Janeway's plugin_loader.get_plugin() looks up the Plugin row by name=
# the *directory name* (lowercase). PLUGIN_NAME above must match that, or
# the loader silently skips the plugin and no hooks register. DISPLAY_NAME
# is the human-readable label.

# Optional bootstrap list: journal codes switched on at install time. Empty
# by default, so a fresh install is dormant on every journal until an editor
# enables it from the manager UI. After install the canonical truth is the
# per-journal SettingValue for `plugin:lawsnotes / enabled`; adding codes here
# later has no effect unless `install_plugins lawsnotes` is re-run.
ENABLED_JOURNAL_CODES = set()

SETTING_GROUP_NAME = "plugin:lawsnotes"
SETTING_NAME = "enabled"

# Per-journal: how many articles the Latest Articles homepage element
# shows. Editable from the element's Configure page in the manager UI.
LATEST_COUNT_SETTING = "latest_articles_count"
LATEST_COUNT_DEFAULT = 10

# Customisation surface ------------------------------------------------
#
# Every entry below becomes a per-journal Setting that the journal
# manager's UCL Laws manage page (`/plugins/lawsnotes/manager/`) renders as a
# form input. Editors can self-serve brand colours, fonts, the
# backdrop logo, layout dimensions, and arbitrary CSS overrides
# without ever touching server-side code -- the head_css hook reads
# these settings on every request and emits them as CSS custom
# properties (`:root { --lawsnotes-color-primary: ...; }`) plus a final
# free-form CSS block for one-off patches.
#
# Adding a new customisation: add a row here, reference its
# `--lawsnotes-*` variable in lawsnotes.css (or a window.lawsnotesSettings.* in
# lawsnotes.js for behavioural toggles), and re-run `install_plugins
# lawsnotes` to create the Setting row in the live DB. No template
# edits needed -- manage.html iterates this list.
CUSTOMISATION_SETTINGS = [
    # ----- Brand colours ---------------------------------------------
    {"name": "color_page", "type": "char", "default": "#F2F2F2",
     "label": "Page background (cream)",
     "css_var": "--lawsnotes-color-page",
     "section": "colours",
     "help": "Backdrop colour around the article paper. Hex or rgb()/hsl()."},
    {"name": "color_paper", "type": "char", "default": "#FFFFFF",
     "label": "Article paper colour",
     "css_var": "--lawsnotes-color-paper",
     "section": "colours",
     "help": "The centred reading surface."},
    {"name": "color_primary", "type": "char", "default": "#113B3A",
     "label": "Primary accent (dark green)",
     "css_var": "--lawsnotes-color-primary",
     "section": "colours",
     "help": "Used for inline links, citation, sidenote borders, drop caps."},
    {"name": "color_secondary", "type": "char", "default": "#002248",
     "label": "Secondary accent (dark blue)",
     "css_var": "--lawsnotes-color-secondary",
     "section": "colours",
     "help": "Used for the journal banner heading and major page titles."},
    {"name": "color_text", "type": "char", "default": "#2a2a2a",
     "label": "Body text colour",
     "css_var": "--lawsnotes-color-text",
     "section": "colours",
     "help": "Default colour for body paragraphs."},
    {"name": "color_muted", "type": "char", "default": "#555",
     "label": "Muted / secondary text colour",
     "css_var": "--lawsnotes-color-muted",
     "section": "colours",
     "help": "Captions, metadata lines, helper text."},
    # ----- Typography ------------------------------------------------
    {"name": "font_body", "type": "text",
     "default": "'Newsreader', Georgia, 'Times New Roman', serif",
     "label": "Body font-family",
     "css_var": "--lawsnotes-font-body",
     "section": "typography",
     "help": "CSS font-family stack for body text."},
    {"name": "font_heading", "type": "text",
     "default": "'Newsreader', Georgia, 'Times New Roman', serif",
     "label": "Heading font-family",
     "css_var": "--lawsnotes-font-heading",
     "section": "typography",
     "help": "CSS font-family stack for headings (h1–h6)."},
    {"name": "font_extra_css_url", "type": "char", "default": "",
     "label": "Extra webfont CSS URL (optional)",
     "section": "typography",
     "help": "URL of a Google Fonts / Adobe Fonts / etc stylesheet "
             "to import into the page head. Leave blank to use only "
             "the bundled Newsreader webfont."},
    # Up to three uploaded font files. The manage view handles the
    # file-upload form; the URL it produces lands in
    # uploaded_font_N_url, the family name stays editable in
    # uploaded_font_N_family. The head_css hook iterates these and
    # emits one @font-face per filled-in pair, before the main
    # stylesheet, so editors can set font_body / font_heading to
    # the uploaded family by name.
    {"name": "uploaded_font_1_url", "type": "char", "default": "",
     "label": "Uploaded font #1 URL (auto-filled by upload)",
     "section": "typography_upload",
     "help": "Auto-filled when a file is uploaded below. You can also "
             "paste an externally-hosted woff2/woff/ttf URL here "
             "manually.",
     "readonly_in_form": True},
    {"name": "uploaded_font_1_family", "type": "char", "default": "",
     "label": "Uploaded font #1 family name",
     "section": "typography_upload",
     "help": "The font-family name used to reference this upload in "
             "the Body / Heading font-family fields above (and in "
             "custom CSS). Pick anything, e.g. 'CustomSerif'."},
    {"name": "uploaded_font_2_url", "type": "char", "default": "",
     "label": "Uploaded font #2 URL",
     "section": "typography_upload",
     "help": "(See font #1.)",
     "readonly_in_form": True},
    {"name": "uploaded_font_2_family", "type": "char", "default": "",
     "label": "Uploaded font #2 family name",
     "section": "typography_upload",
     "help": "(See font #1.)"},
    {"name": "uploaded_font_3_url", "type": "char", "default": "",
     "label": "Uploaded font #3 URL",
     "section": "typography_upload",
     "help": "(See font #1.)",
     "readonly_in_form": True},
    {"name": "uploaded_font_3_family", "type": "char", "default": "",
     "label": "Uploaded font #3 family name",
     "section": "typography_upload",
     "help": "(See font #1.)"},
    # ----- Logo backdrop ---------------------------------------------
    {"name": "logo_url", "type": "char",
     "default": "",
     "label": "Backdrop logo URL",
     "css_var": "--lawsnotes-logo-image",
     "css_format": 'url("{0}")',
     "section": "logo",
     "help": "URL or path to a logo image (SVG/PNG/WebP). Sits behind "
             "the article paper, anchored flush to the bottom of the "
             "viewport. Blank by default; no logo is shipped with the "
             "plugin. Upload one through the journal's media files, or "
             "point this at any URL your install serves."},
    {"name": "logo_opacity", "type": "char", "default": "0.3",
     "label": "Backdrop logo opacity (0–1)",
     "css_var": "--lawsnotes-logo-opacity",
     "section": "logo",
     "help": "0 = invisible, 1 = fully opaque. Recommended 0.15–0.4."},
    {"name": "logo_height", "type": "char", "default": "100vh",
     "label": "Backdrop logo height",
     "css_var": "--lawsnotes-logo-height",
     "section": "logo",
     "help": "CSS length for the logo backdrop area "
             "(e.g. 100vh, 50vh, 360px)."},
    # ----- Layout ----------------------------------------------------
    {"name": "paper_max_width", "type": "char", "default": "1280px",
     "label": "Article paper max-width",
     "css_var": "--lawsnotes-paper-max-width",
     "section": "layout",
     "help": "Maximum width of the reading surface (CSS length)."},
    {"name": "sidenote_breakpoint", "type": "char", "default": "1280",
     "label": "Sidenote breakpoint (px)",
     "section": "layout",
     "help": "Viewport width (px) at which sidenotes appear in the "
             "margin. Below this, footnotes show as tap/hover popovers."},
    {"name": "sidenote_width", "type": "char", "default": "220",
     "label": "Sidenote width (px)",
     "section": "layout",
     "help": "Width of each sidenote column in the gutter."},
    # ----- Behaviour toggles -----------------------------------------
    {"name": "show_drop_caps", "type": "boolean", "default": "on",
     "label": "Show drop caps on article body",
     "section": "behaviour",
     "help": "First letter of the first paragraph rendered as a "
             "decorative drop cap."},
    {"name": "hide_cite_dropdown", "type": "boolean", "default": "on",
     "label": "Hide the OLH 'Cite article' dropdown",
     "section": "behaviour",
     "help": "Hides the speech-bubble Cite menu in the article options "
             "bar. The OSCOLA 'How to cite' block under the abstract "
             "remains as the canonical citation surface."},
    {"name": "hide_endnote_list_when_sidenotes",
     "type": "boolean", "default": "on",
     "label": "Hide bottom-of-article endnote list when sidenotes are active",
     "section": "behaviour",
     "help": "On wide viewports where sidenotes show in the margin, "
             "the redundant numbered endnote list at the foot of the "
             "article is hidden."},
    # ----- Free-form override ----------------------------------------
    {"name": "custom_css", "type": "text", "default": "",
     "label": "Custom CSS (advanced)",
     "section": "custom",
     "help": "Arbitrary CSS appended to the <head> after every other "
             "stylesheet. Use this to patch anything not covered by "
             "the fields above without waiting for a plugin update."},
    {"name": "custom_js", "type": "text", "default": "",
     "label": "Custom JavaScript (advanced)",
     "section": "custom",
     "help": "Arbitrary JS executed after lawsnotes.js has bootstrapped. "
             "Wrap behaviour in window.lawsnotesOnReady(fn) for safe "
             "ordering. Available globals: lawsnotesSettings (config), "
             "lawsnotesJournalName, lawsnotesApiUrl, lawsnotesShowTooltipForMarker. "
             "Errors are caught and logged to the console so a "
             "broken snippet never breaks the page."},
    {"name": "custom_js_url", "type": "char", "default": "",
     "label": "Custom JavaScript URL (optional)",
     "section": "custom",
     "help": "Externally-hosted JS file loaded after lawsnotes.js. Useful "
             "for patches longer than the textarea or maintained in "
             "version control elsewhere. Loaded with `defer`."},
    # ----- Access delegation -----------------------------------------
    {"name": "extra_access_roles", "type": "char", "default": "",
     "label": "Additional roles allowed to manage UCL Laws settings",
     "section": "access",
     "help": "Comma-separated Janeway role short-names "
             "(e.g. 'production-manager, copyeditor, typesetter'). "
             "Anyone holding one of these roles on this journal will "
             "be able to open this manage page in addition to the "
             "always-allowed editors / journal-managers / sysadmins. "
             "Leave blank to keep access at the default."},
]

# Sections are rendered as collapsible groups in manage.html.
CUSTOMISATION_SECTIONS = [
    ("colours", "Colours"),
    ("typography", "Typography"),
    ("typography_upload", "Custom font uploads"),
    ("logo", "Backdrop logo"),
    ("layout", "Layout"),
    ("behaviour", "Behaviour"),
    ("custom", "Custom CSS / JS"),
    ("access", "Who can manage these settings?"),
]


def customisation_cache_key(journal):
    return "lawsnotes:cust:{0}".format(journal.pk)


def invalidate_customisation(journal):
    """Drop this journal's cached settings. Called by the manage view
    after a save so edits are visible on the next request rather than
    after the cache TTL."""
    if journal:
        cache.delete_many([
            customisation_cache_key(journal),
            enabled_cache_key(journal),
        ])


def get_customisation(journal):
    """Read every CUSTOMISATION_SETTINGS row for `journal` and return a
    dict of `{name: processed_value-or-default}`. Used by the head_css
    hook (to build the :root variables block + custom_css trailer)
    and by the manage view (to populate the form). Falls back to
    each setting's default when the per-journal value is empty so a
    fresh install still renders correctly.

    Cached per journal. head_css runs on every page of an enabled
    journal, and Janeway's get_plugin_setting does two queries per
    lookup with no caching of its own -- uncached this would put
    ~60 queries on every single page render. The manage view calls
    invalidate_customisation() on save, so the TTL only matters if a
    SettingValue is changed out-of-band (shell, admin, fixture)."""
    out = {}
    for spec in CUSTOMISATION_SETTINGS:
        out[spec["name"]] = spec["default"]

    plugin = get_self()
    if not (plugin and journal):
        return out

    key = customisation_cache_key(journal)
    cached = cache.get(key)
    if cached is not None:
        return cached

    try:
        from utils.setting_handler import get_plugin_setting
    except Exception:
        return out
    for spec in CUSTOMISATION_SETTINGS:
        try:
            sv = get_plugin_setting(plugin, spec["name"], journal)
        except Exception:
            continue
        if sv is None:
            continue
        val = sv.processed_value
        # Booleans are stored as on/off strings; normalise to bool.
        if spec["type"] == "boolean":
            out[spec["name"]] = bool(val)
            continue
        if val in (None, ""):
            continue
        out[spec["name"]] = val

    cache.set(key, out, CUSTOMISATION_CACHE_TTL)
    return out

# Janeway's homepage view iterates HomepageElement rows for each journal
# and includes their template_path. Editors enable/order them in the
# manager's Edit Homepage page. We register a "Latest Articles" element
# at install time -- inactive by default for non-bootstrap journals,
# active by default for journals in ENABLED_JOURNAL_CODES.
HOMEPAGE_ELEMENT_NAME = "Latest Articles"
HOMEPAGE_ELEMENT_TEMPLATE = "lawsnotes/homepage_elements/latest_articles.html"
HOMEPAGE_ELEMENT_CONFIGURE_URL = "lawsnotes_configure_latest"

# Read by core/views.py:plugin_list to render a "Manage" button on the
# Plugins page in the manager UI. Resolved through django.urls.reverse,
# so the value is a URL *name* registered in plugins/lawsnotes/urls.py.
MANAGER_URL = "lawsnotes_manager"


def get_self():
    try:
        return models.Plugin.objects.get(name=PLUGIN_NAME)
    except models.Plugin.DoesNotExist:
        return None


def enabled_cache_key(journal):
    return "lawsnotes:enabled:{0}".format(journal.pk)


def is_enabled_for(journal):
    """Single source of truth for the per-journal kill switch.

    Returns True iff the plugin's `enabled` SettingValue is on for
    this journal. Every plugin entry-point that produces output for
    a journal -- the head_css hook, the homepage element hook, the
    JSON card-metadata API -- gates on this so disabling the plugin
    in one place (the manager UI's per-journal Setting) silences
    every aspect of it for that journal.

    Cached alongside the customisation dict, and for the same reason:
    this runs on every request to every journal on the install,
    including the ones where the answer is False.
    """
    if not journal:
        return False

    key = enabled_cache_key(journal)
    cached = cache.get(key)
    if cached is not None:
        return cached

    plugin = get_self()
    if not plugin:
        return False
    try:
        from utils.setting_handler import get_plugin_setting
        sv = get_plugin_setting(plugin, SETTING_NAME, journal)
    except Exception:
        return False
    value = bool(sv and sv.processed_value)
    cache.set(key, value, CUSTOMISATION_CACHE_TTL)
    return value


def install():
    """Called by `manage.py install_plugins lawsnotes`. Creates:

      1. The Plugin row so Janeway loads us at boot.
      2. The SettingGroup `plugin:lawsnotes` and a boolean Setting `enabled`,
         which appears in each journal's manager UI.
      3. Per-journal SettingValue rows: 'on' for journals named in
         ENABLED_JOURNAL_CODES (the bootstrap list), default 'off'
         otherwise.

    After install, editors can toggle the plugin per journal from
    `/<journal-code>/manager/settings/` without shell access -- no
    further code edits required to roll out to additional journals.
    """
    import core.models as core_models
    import journal.models as journal_models
    from utils import setting_handler

    plugin, created = models.Plugin.objects.get_or_create(
        name=PLUGIN_NAME,
        defaults={
            "enabled": True,
            "version": VERSION,
            "display_name": DISPLAY_NAME,
        },
    )
    if not created:
        plugin.version = VERSION
        plugin.enabled = True
        plugin.save()

    setting_group, _ = core_models.SettingGroup.objects.get_or_create(
        name=SETTING_GROUP_NAME,
        defaults={"enabled": True},
    )
    setting, _ = core_models.Setting.objects.get_or_create(
        name=SETTING_NAME,
        group=setting_group,
        defaults={
            "pretty_name": "Enable UCL Laws law-journal styling",
            "types": "boolean",
            "description": (
                "When on, this journal renders article pages with the "
                "UCL Laws layout: minimalist single-paper view, alternating "
                "sidenotes (or popover notes on narrow viewports), "
                "OSCOLA citation, and the bundled Newsreader webfont. "
                "Other journals on this Janeway install are unaffected."
            ),
            "is_translatable": False,
        },
    )
    setting_handler.get_or_create_default_setting(setting, default_value="off")

    # Number setting for the Latest Articles element's article count.
    count_setting, _ = core_models.Setting.objects.get_or_create(
        name=LATEST_COUNT_SETTING,
        group=setting_group,
        defaults={
            "pretty_name": "Latest Articles count",
            "types": "number",
            "description": (
                "How many recent articles to show in the 'Latest Articles' "
                "homepage element."
            ),
            "is_translatable": False,
        },
    )
    setting_handler.get_or_create_default_setting(
        count_setting, default_value=str(LATEST_COUNT_DEFAULT),
    )

    # Customisation settings (colours, fonts, logo, layout, custom CSS).
    # Idempotent: re-running install_plugins after adding a new entry
    # to CUSTOMISATION_SETTINGS creates only the new rows.
    for spec in CUSTOMISATION_SETTINGS:
        s, _ = core_models.Setting.objects.get_or_create(
            name=spec["name"],
            group=setting_group,
            defaults={
                "pretty_name": spec["label"],
                "types": spec["type"],
                "description": spec.get("help", ""),
                "is_translatable": False,
            },
        )
        setting_handler.get_or_create_default_setting(
            s, default_value=spec["default"],
        )

    # Bootstrap per-journal enable rows from ENABLED_JOURNAL_CODES.
    for code in ENABLED_JOURNAL_CODES:
        journal = journal_models.Journal.objects.filter(code=code).first()
        if journal:
            setting_handler.save_plugin_setting(plugin, SETTING_NAME, "on", journal)
            logger.debug("UCL Laws enabled for journal %s.", code)

    # Register the "Latest Articles" homepage element for every journal.
    # active=True for bootstrap journals so the element shows immediately
    # without manual enabling; other journals get an inactive entry that
    # editors can drag to active in the manager UI.
    from django.contrib.contenttypes.models import ContentType
    for j in journal_models.Journal.objects.all():
        ct = ContentType.objects.get_for_model(j)
        active_default = j.code in ENABLED_JOURNAL_CODES
        element, el_created = core_models.HomepageElement.objects.get_or_create(
            name=HOMEPAGE_ELEMENT_NAME,
            content_type=ct,
            object_id=j.pk,
            defaults={
                "template_path": HOMEPAGE_ELEMENT_TEMPLATE,
                "has_config": True,
                "configure_url": HOMEPAGE_ELEMENT_CONFIGURE_URL,
                "available_to_press": False,
                "active": active_default,
                # Sort below other 999-default elements (HTML, Featured,
                # Carousel, etc.) so Latest Articles ends up at the
                # bottom of the homepage by default; editors can drag
                # it up via the manager UI if they prefer.
                "sequence": 1000,
            },
        )
        dirty = False
        if element.template_path != HOMEPAGE_ELEMENT_TEMPLATE:
            element.template_path = HOMEPAGE_ELEMENT_TEMPLATE
            dirty = True
        if element.configure_url != HOMEPAGE_ELEMENT_CONFIGURE_URL:
            element.configure_url = HOMEPAGE_ELEMENT_CONFIGURE_URL
            dirty = True
        if not element.has_config:
            element.has_config = True
            dirty = True
        # Bump existing rows still on the unrolled-default 999.
        if element.sequence == 999:
            element.sequence = 1000
            dirty = True
        if dirty:
            element.save()

    # install() writes SettingValues directly, so drop any cached reads
    # left over from before the run.
    for j in journal_models.Journal.objects.all():
        invalidate_customisation(j)

    logger.debug("UCL Laws plugin installed (created=%s).", created)


def hook_registry():
    """Tell Janeway which template hooks our functions want to be called for."""
    try:
        return {
            "base_head_css": {
                "module": "plugins.lawsnotes.hooks",
                "function": "head_css",
                "name": PLUGIN_NAME,
            },
            "yield_homepage_element_context": {
                "module": "plugins.lawsnotes.hooks",
                "function": "latest_articles_context",
                # Must equal the HomepageElement.name in install() so
                # journal/views.py:home() routes the call to us.
                "name": HOMEPAGE_ELEMENT_NAME,
            },
        }
    except OperationalError:
        # DB not migrated yet (e.g. during initial install). Return nothing.
        return {}
    except BaseException:
        return {}
