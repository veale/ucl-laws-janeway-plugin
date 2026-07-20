# Lawsnotes — a UCL Laws Janeway plugin for beautiful OA law journals full of beautiful scholarship by beautiful people

A [Janeway](https://github.com/openlibhums/janeway) plugin produced by UCL Laws that renders one journal as a law journal: a single-column
reading layout, a serif typeface, and sidenotes (rather than footnotes) generated from the
footnotes Janeway's JATS pipeline already produces.

Law journals carry heavy footnote apparatus. Too heavy, some might say. Janeway's stock output puts every
footnote in a numbered list at the foot of the article, so reading a densely
annotated piece means jumping to the bottom and back for each note. This plugin
moves those notes into the page margin beside the text that cites them, and
falls back to hover/tap popovers when the viewport is too narrow for a margin.

(PS: The plugin is named `lawsnotes` internally, because Janeway imports a plugin
directory as a Python module and hyphens are not valid in module names.)

## What it does

Sidenotes: Each footnote is cloned into an `<aside>` positioned beside its
citing paragraph, alternating right and left down the page. We think this is pretty novel! Long notes fold
behind a "more" toggle. Below a configurable breakpoint (1280px by default) the
sidenotes are replaced by popovers anchored to the footnote marker, and the
endnote list at the foot of the article reappears.

Reading layout: Title, article options bar, and body are unified into one
centred surface with a configurable maximum width. Body text is set in
Newsreader, a variable serif whose optical-size axis tracks font size.

Citations: Renders each article's `custom_how_to_cite` field with the DOI as a
real link. The plugin styles this field; it does not generate citations, and it
assumes whatever you put there is already in your preferred format.

Latest Articles homepage element: An optional homepage block listing recent
articles with abstract previews and author names, with a configurable count. For some reason Janeway doesn't have one of these.

Everything is driven off the class names and id patterns Janeway's default JATS
XSLT already emits (`a.xref-fn`, `ol.footnotes`, `li#fn*`). We don't change it.

## Why it is low-risk to host (how we and you can convince your OA press to install this)

The plugin is one directory under `src/plugins/`. Janeway core is not patched,
no theme is forked, no XSLT is forked, and no database migrations are run.
Removing the directory reverts the install. Safety! Reversibility!

It is off by default on every journal (so it doesn't bork your press). All of its output: the stylesheet and
script injection, the homepage element, the JSON endpoint — passes through a
single `is_enabled_for(journal)` gate that reads a per-journal setting. Until an
editor turns that on for a specific journal, requests to every journal on the
press get the stock `<head>` and stock templates, or whatever you have set, with nothing in the page
referencing the plugin. **Enabling it on one journal has no effect on any other**.

Its database footprint is what `install_plugins` creates for any Janeway
plugin: one Plugin row, one SettingGroup, the Settings under it, and one
HomepageElement pointer per journal. Uninstalling is deleting those rows.

Once installed, ongoing administrator involvement is close to zero. Colours,
fonts, layout dimensions, the breakpoint, the backdrop logo, and free-form
CSS and JavaScript overrides are all per-journal settings editable from the
journal manager UI. This means the journal admins can make some changes without having to update the plugin. Changes take effect on the next request — no restart, no
asset rebuild, no deploy, no asking your admin to help you out. An editor can patch a styling problem without filing
a ticket against the host, or without bothering them.

## Installing

This *does* have to be done by an admin.

Copy the `lawsnotes/` directory to `<janeway-source>/src/plugins/lawsnotes/`,
then register it and restart:

```bash
python manage.py install_plugins lawsnotes
sudo systemctl restart janeway   # or however your install is served
```

Janeway loads plugins at process start, so the restart is required before the
hooks fire.

To turn it on for a journal, open that journal's manager, go to Plugins, find
UCL Laws, click Manage, tick Enabled, and save. Equivalently from a shell:

```python
from utils.models import Plugin
from journal.models import Journal
from utils.setting_handler import save_plugin_setting

save_plugin_setting(
    Plugin.objects.get(name="lawsnotes"),
    "enabled",
    True,
    Journal.objects.get(code="your-journal-code"),
)
```

Pass `True` or `False`, not `"on"` or `"off"`. Janeway stores booleans as
`"on" if value else ""`, and the string `"off"` is truthy in Python, so passing
it turns the setting on.

To confirm the scoping is working, load a page on the enabled journal and check
that `<head>` contains `lawsnotes.css` and `lawsnotes.js`, then load a page on
any other journal and check that it does not.

The Latest Articles element is optional and separate: enable it from Manage
Homepage in the journal manager, where Configure sets how many articles show.

## Configuration

Everything below is per-journal and lives on the plugin's Manage page.

| Group | Controls |
| --- | --- |
| Colours | Page backdrop, reading surface, primary and secondary accent, body and muted text |
| Typography | Body and heading font stacks, an optional external webfont stylesheet URL, and up to three uploaded font files |
| Backdrop logo | Image URL, opacity, height. Blank by default; no logo ships with the plugin |
| Layout | Reading surface max width, sidenote breakpoint, sidenote width |
| Behaviour | Drop caps, hiding the theme's Cite dropdown, hiding the endnote list when sidenotes are showing |
| Custom CSS / JS | Free-form CSS and JavaScript, inline or by URL, injected after everything else |
| Access | Extra Janeway roles permitted to edit these settings, beyond editors and journal managers |

The custom CSS and JavaScript fields inject author-controlled content into the
page. Anyone who can reach the Manage page can therefore run script in the
context of that journal. Access defaults to editors, journal managers, and
staff; the Access setting widens it. Treat it as equivalent to template edit
rights and grant it accordingly.

## Requirements and limitations

Requires a theme that fires the `base_head_css` template hook. OLH and `clean`
do; `material` does not, and the plugin will not load there.

The sidenote logic depends on the footnote markup Janeway's default JATS XSLT
emits. A journal running a custom XSLT that changes those class names or id
patterns needs the selector constants at the top of `lawsnotes.js` updated to
match.

Font and logo URLs in the stylesheet are absolute `/static/lawsnotes/...`
paths, because a static CSS file cannot resolve Django's `{% static %}` tag. An
install serving static assets from a non-default `STATIC_URL`, such as a CDN,
needs those paths adjusted.

Sidenotes need horizontal room. Below the breakpoint the layout degrades to
popovers by design, so the margin apparatus is genuinely absent on phones
rather than merely narrow. It degrades gracefully, even beautifully.

## Layout

```
lawsnotes/
├── plugin_settings.py   metadata, install(), the enabled gate, hook registry
├── hooks.py             head_css injection, homepage element context
├── views.py             manage page, element configure page, card JSON endpoint
├── urls.py
├── static/lawsnotes/    lawsnotes.css, lawsnotes.js, Newsreader woff2 files
└── templates/lawsnotes/ manage, configure, and homepage element templates
```

## Uninstalling

```bash
python manage.py shell -c "
from utils.models import Plugin
from core.models import SettingGroup
Plugin.objects.filter(name='lawsnotes').delete()
SettingGroup.objects.filter(name='plugin:lawsnotes').delete()
"
rm -rf src/plugins/lawsnotes
sudo systemctl restart janeway
```

Normal journal styling resumes immediately.

## Licence

AGPL v3, matching Janeway. See [LICENSE](LICENSE). The bundled Newsreader
fonts are licensed separately under the SIL Open Font License 1.1; see
[lawsnotes/static/lawsnotes/fonts/README.md](lawsnotes/static/lawsnotes/fonts/README.md).

If you use it, we would appreciate a credit to UCL Faculty of Laws.
