#!/usr/bin/env python3
"""Static consistency checks for the lawsnotes plugin.

None of this needs Janeway or a database. It catches the class of mistake
that otherwise stays invisible until the plugin is loaded on a live
install: a stylesheet pointing at an asset that was renamed or deleted, a
template path that no longer exists, or PLUGIN_NAME drifting away from the
directory name (which makes Janeway's loader skip the plugin silently).

Run: python3 scripts/check_integrity.py
"""

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PLUGIN_DIR = ROOT / "lawsnotes"
STATIC_ROOT = PLUGIN_DIR / "static"
TEMPLATE_ROOT = PLUGIN_DIR / "templates"

SOURCE_GLOBS = ("*.py", "*.js", "*.css", "*.html")

failures = []


def fail(msg):
    failures.append(msg)


def source_files():
    for pattern in SOURCE_GLOBS:
        yield from PLUGIN_DIR.rglob(pattern)


def rel(path):
    return path.relative_to(ROOT)


def check_plugin_name():
    """Janeway looks the Plugin row up by directory name. If PLUGIN_NAME
    disagrees, the loader finds nothing and no hooks register -- with no
    error message."""
    settings = (PLUGIN_DIR / "plugin_settings.py").read_text()
    match = re.search(r'^PLUGIN_NAME\s*=\s*["\'](.+?)["\']', settings, re.M)
    if not match:
        fail("plugin_settings.py: PLUGIN_NAME not found")
        return
    name = match.group(1)
    if name != PLUGIN_DIR.name:
        fail(
            "PLUGIN_NAME is {0!r} but the plugin directory is {1!r}; "
            "Janeway's loader would skip the plugin".format(name, PLUGIN_DIR.name)
        )
    group = re.search(r'^SETTING_GROUP_NAME\s*=\s*["\'](.+?)["\']', settings, re.M)
    if group and group.group(1) != "plugin:{0}".format(name):
        fail(
            "SETTING_GROUP_NAME is {0!r}; Janeway's get_plugin_setting builds "
            "'plugin:{1}' from the plugin name, so settings would never "
            "resolve".format(group.group(1), name)
        )


# /static/lawsnotes/foo.css  and  url('/static/lawsnotes/fonts/x.woff2')
ABS_STATIC_RE = re.compile(r"/static/(lawsnotes/[A-Za-z0-9_./-]+)")
# static("lawsnotes/lawsnotes.css")  and  {% static 'lawsnotes/x' %}
TAG_STATIC_RE = re.compile(r"""static\(?\s*["'](lawsnotes/[A-Za-z0-9_./-]+)["']""")


def check_static_references():
    """Every static asset referenced in source must exist on disk."""
    for path in source_files():
        text = path.read_text(errors="ignore")
        refs = set(ABS_STATIC_RE.findall(text)) | set(TAG_STATIC_RE.findall(text))
        for ref in sorted(refs):
            if not (STATIC_ROOT / ref).exists():
                fail("{0}: references missing static asset {1}".format(rel(path), ref))


TEMPLATE_RE = re.compile(r"""["'](lawsnotes/[A-Za-z0-9_./-]+\.html)["']""")


def check_template_references():
    """Template paths named in Python must exist under templates/."""
    for path in PLUGIN_DIR.rglob("*.py"):
        text = path.read_text(errors="ignore")
        for ref in sorted(set(TEMPLATE_RE.findall(text))):
            if not (TEMPLATE_ROOT / ref).exists():
                fail("{0}: references missing template {1}".format(rel(path), ref))


def check_hook_targets():
    """Each hook_registry entry must name a function that actually exists,
    and a module path that matches this package."""
    settings = (PLUGIN_DIR / "plugin_settings.py").read_text()
    hooks_src = (PLUGIN_DIR / "hooks.py").read_text()
    defined = set(re.findall(r"^def\s+(\w+)", hooks_src, re.M))
    expected_module = "plugins.{0}.hooks".format(PLUGIN_DIR.name)

    for module, func in re.findall(
        r'"module":\s*"([^"]+)".*?"function":\s*"([^"]+)"', settings, re.S
    ):
        if module != expected_module:
            fail(
                "hook_registry references module {0!r}, expected {1!r}".format(
                    module, expected_module
                )
            )
        if func not in defined:
            fail(
                "hook_registry references hooks.{0}(), which is not defined "
                "in hooks.py".format(func)
            )


CSS_VAR_DECLARED_RE = re.compile(r'"css_var":\s*"(--[a-z0-9-]+)"')
CSS_VAR_USED_RE = re.compile(r"var\(\s*(--lawsnotes-[a-z0-9-]+)")


def check_css_variables():
    """Every setting that declares a css_var must have the stylesheet
    actually read it.

    The customisation settings are only real if some rule consumes the
    custom property they emit. A setting whose variable nothing reads
    still renders a labelled input on the manage page, so an editor
    changes it, saves, and sees no effect anywhere -- a silent failure
    with no error to trace.
    """
    settings = (PLUGIN_DIR / "plugin_settings.py").read_text()
    declared = set(CSS_VAR_DECLARED_RE.findall(settings))

    used = set()
    for path in PLUGIN_DIR.rglob("*.css"):
        used |= set(CSS_VAR_USED_RE.findall(path.read_text(errors="ignore")))

    for var in sorted(declared - used):
        fail(
            "plugin_settings.py declares css_var {0} but no stylesheet reads "
            "it; the setting would render a control that does nothing".format(var)
        )


def check_no_stale_identifiers():
    """The plugin was renamed from an earlier internal name; catch any
    reference that survives a future rename."""
    stale = ("gcdc",)
    for path in source_files():
        text = path.read_text(errors="ignore").lower()
        for token in stale:
            if token in text:
                fail("{0}: contains stale identifier {1!r}".format(rel(path), token))


def main():
    if not PLUGIN_DIR.is_dir():
        print("plugin directory not found: {0}".format(PLUGIN_DIR))
        return 1

    check_plugin_name()
    check_static_references()
    check_template_references()
    check_hook_targets()
    check_css_variables()
    check_no_stale_identifiers()

    if failures:
        print("Integrity checks failed:\n")
        for msg in failures:
            print("  - {0}".format(msg))
        return 1

    print("Integrity checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
