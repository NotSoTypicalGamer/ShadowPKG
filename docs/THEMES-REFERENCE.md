# ShadowPKG themes: reference for AI agents

This is the exhaustive companion of `docs/THEMES-FOR-AGENTS.md` (the core guide). Do not read it top to bottom: the core guide is complete for making a theme, and sends you to one section here (R1 to R14) only when it needs detail. Everything below that comes from the code (regular expressions, limits, the token table, the pairs, the messages, the base looks, the examples' check output) is read from `server.js` and `index.html` by a script, so it matches the code. Theme format 1.

Contents: R1 Manifest fields, R2 Limits, R3 Token catalogue and overrides, R4 Value grammars and regular expressions, R5 CSS, R6 Assets, R7 Readability pairs, R8 Base looks in full, R9 What each preview image shows, R10 Raw API and installing on a running server, R11 Validator messages, R12 Frequent mistakes, R13 More worked examples, R14 Prompt template.

## R1. Manifest fields

| Field | Type | Required | Rule |
|---|---|---|---|
| `shadowtheme` | number | yes | Exactly `1`. |
| `id` | text | no in a file (write it anyway) | `/^[a-z0-9][a-z0-9-]{0,31}$/`; not a built-in id; not a Windows device name (`/^(con\|prn\|aux\|nul\|com[1-9]\|lpt[1-9])(\.\|$)/i`). Left out: the file or folder name is used, or a slug of the name when the manifest is posted without one. |
| `name` | text | yes | 1 to 40 characters after trimming, none of `<` `>` or the characters in "Text characters" below. |
| `author` | text | no | At most 40 characters, same rule. |
| `description` | text | no | At most 140 characters, same rule. |
| `version` | text | no | At most 16 characters, same rule. Shown, never compared. |
| `base` | text | no | One of `ps1 ps1v2 midnight purple nes snes dreamcast wii itsmemario yoshisisland oled nathan win95 spookemon`. Default `midnight`. |
| `mode` | text | no | `dark` or `light`. Default: inferred (core step 3). |
| `palette` | object | see below | Keys `background surface text accent surface2 dialog tray link good bad warn`. Each a `#rgb` or `#rrggbb` colour, or `rgb()` / `rgba()` / `hsl()` / `hsla()` with three plain numbers and no alpha. Stored as lower-case `#rrggbb`. An unknown key is ignored with a warning; `surface2` is known and does nothing. |
| `tokens` | object | see below | Keys from the catalogue in R3 (an unknown key is an error). Each value must fit the token's type (R4). |
| `fonts` | list | no | At most 4 entries `{family, src, weight}`: `family` `/^[A-Za-z][A-Za-z0-9 _.-]{0,39}$/` and not `pixelchrome serif sans-serif monospace cursive fantasy system-ui inherit initial unset default` in any capitals; `src` is `assets/<font file>` (folder) or `data:font/(woff2\|woff\|ttf\|otf);base64,...` (at most 900 KB decoded); `weight` is `100` to `900` in hundreds, `normal` or `bold` (default `400`). |
| `css` | text | see below | Extra rules (R5). At most 60 KB. |
| `logo` | text | no | Folder themes only. One `assets/<file>` picture (`.png .jpg .jpeg .webp .gif .svg`) shown in the header in place of the built-in glyph; the wordmark text is hidden. An SVG must pass core step 8. |
| `icons` | object | no | Folder themes only. A map of icon kind to `assets/<file>` picture overriding the built-in row icon. Kinds: `file document text image video audio archive disk code package folder`; an unknown kind is ignored with a warning. |

At least one of `palette`, `tokens`, `css` must give something: a palette with at least one known colour, a `tokens` with at least one key, css that produces at least one rule, or the server says "a theme needs at least one of palette, tokens or css". A palette needs none of its four seeds (the base look supplies a missing one), but write all four.

**Text characters.** `name`, `author`, `description` and `version` may not contain control characters, line or paragraph separators, zero-width or bidirectional-control characters, U+FFFD, a lone surrogate, `<` or `>`. Exact pattern in the server:

```
/[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff\ufffd]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
```

## R2. Limits

| Thing | Limit |
|---|---|
| Single-file theme | 1 MiB, measured on the manifest as the server writes it back |
| Folder theme | 4 MiB in all, at most 24 files (`theme.json` and `theme.css` count), each at most 1.5 MiB |
| Themes on one server | 64 (more are not offered) |
| Entries in the themes folder that are looked at | 200 |
| Picture in a `data:` URL | 300 KB decoded |
| Font in a `data:` URL | 900 KB decoded |
| css (manifest and theme.css together) | 60 KB, 200 rules, 40 declarations a rule, a selector at most 200 characters and 20 parts, a string at most 100 characters |
| fonts | 4 entries |
| A token value | 300 characters (not counting embedded picture data) |
| Font list | 8 families, 200 characters |
| Image layers, gradient stops, shadows | 3 layers, 2 to 6 stops, 4 shadows |
| name / author / description / version | 40 / 40 / 140 / 16 characters |
| id | 1 to 32 characters |
| A check or install request | 6 MiB |
| A theme kept by one browser only | about 1 MB together (the page, not the server); a theme with an embedded font or picture counts about twice, so about 450 KB of embedded data is the practical limit |

## R3. Token catalogue and overrides

Generated from `server.js` `THEME_TOKENS` and cross-checked against `index.html` and the fourteen built-in themes. Between them the built-in themes define every token; eleven of the fourteen leave `--panel-busy` out, and the page then uses `--icon`. "Derivation" says what the page does when the theme does not override the token. `docs/theme-tokens.json` is the same catalogue as data: `{version, count, groups, types, paletteKeys, unusedPaletteKeys, tokens}` where each token is `{name, type, group, description, derivedFrom, derivation, contrastPairs}`; `derivedFrom` lists every manifest input (palette keys, `mode`, `base`) whose change can change the derived value, and `contrastPairs` lists every readability pair the token is in.

| Token | Type | What it colours | Derivation |
|---|---|---|---|
| **Page** | | | |
| `--meta` | colour | The browser's own top bar on phones (the theme-color meta tag). The page draws nothing with it. | The page colour (--bg). |
| `--bg` | colour | The page behind everything. --bg-image is drawn over it. | palette.background, moved off the mid-tones until text can reach 7.3:1 on it (toward dark in a dark theme, toward light in a light one). If the surface is on the other side of the page (dark page, light panels) the two are pushed apart to 11:1 (13.5:1 on a glossy base). |
| `--bg-image` | image | Up to 3 gradient or url() layers drawn over --bg on the body. none for nothing. The first layer is on top. | Always none; only a token override sets it. |
| `--text` | colour | Main text on the page, in dialogs and on the bottom tray. | palette.text (default near-white on a dark page, near-black on a light one), moved until it reaches 7.1:1 on the page, the dialog background and every tray colour. |
| `--muted` | colour | Quiet text on the page and in dialogs: captions, hints, placeholders, breadcrumb separators, the footer credits. | The text colour mixed 40% toward the page colour, moved until it reaches 5.3:1 (a margin over 4.5:1) on the page, dialogs and the tray. |
| `--link` | colour | The title (h1), breadcrumb links, the library menu, running-state lines on the page and the count on the tray. | palette.link, else palette.accent; moved until it reaches 4.7:1 on the page, dialogs and the tray. |
| `--focus` | colour | The keyboard focus outline; also the border of a focused text box and of the chosen theme in the picker. | palette.accent, moved until it reaches 3.1:1 on the page and on the panel. |
| **Panels** | | | |
| `--panel` | paint | Panels: the file list, cards, menus, the toolbar, toasts. A gradient gives shading. | palette.surface. Flat bases: one colour. Glossy bases: a gradient from 3.5% lighter to 3.5% darker. Every stop is moved off the mid-tones until text can reach 7.3:1 on it. |
| `--panel-text` | colour | Text on panels. | The text colour when it reaches 7.1:1 on every panel stop; otherwise near-white or near-black tinted with the surface hue, at 7.1:1. |
| `--panel-muted` | colour | Quiet text on panels: file details, timestamps, list header text, the History labels, the Cancelled pill. | The panel text mixed 38% toward the panel colour, moved until it reaches 4.7:1 on the panel, the list header, a hovered row and the Cancelled pill. |
| `--panel-head` | colour | The background of a list's header row. | The panel colour mixed 7% toward the panel text. |
| `--line` | colour | Dividers and borders: panels, rows, menus, dialogs, the toolbar, the library menu. | The panel colour mixed 24% toward the panel text. |
| `--hover` | colour | A row or menu item under the pointer. | The panel colour mixed 5% toward the panel text. |
| `--panel-shadow` | shadow | The edge and shadow of panels, menus and the toolbar (a box-shadow list). | Glossy bases: a light and a dark bevel plus 0 3px 0 rgba(0,0,0,.3). Flat bases: none in a dark theme, 0 1px 3px rgba(0,0,0,.12) in a light one. |
| `--icon` | colour | Folder and file icons. Also the running-state colour on panels when --panel-busy is not set. | palette.accent, moved until it reaches 4.7:1 on the panel and on the Building pill. |
| **Selection** | | | |
| `--sel` | paint | A selected row, the current menu item, a checked filter chip, the active profile. | The panel colour mixed 26% (light panel) or 32% (dark panel) toward palette.accent, moved until text can reach 5:1 (5.6:1 on a glossy base). Glossy bases: a gradient 3% lighter to 3% darker. |
| `--sel-text` | colour | Text on a selected row. | The panel text, moved until it reaches 4.7:1 on the selection. |
| `--sel-muted` | colour | Quiet text on a selected row. | The selection text mixed 30% toward the selection colour, moved until it reaches 4.7:1 on the selection. |
| `--check` | colour | The tick of native checkboxes (accent-color). | The accent as it ends up under --accent (its first stop). |
| **Buttons** | | | |
| `--accent` | paint | Main buttons, the progress bar fill and the count bubble. | palette.accent, moved until white (or #0b0b12, whichever moves it less) reaches 5.2:1 on it. Glossy bases: a gradient 5% lighter to 5% darker. |
| `--accent-2` | paint | A main button under the pointer. | The accent 7% lighter, moved until the button text reaches 4.7:1 on it. |
| `--on-accent` | colour | Text on main buttons. | White or #0b0b12: whichever needs the accent moved less. |
| **Outline buttons** | | | |
| `--ghost-bg` | paint | Secondary buttons (Refresh, Test, Edit), the target buttons and filter chips. | Flat bases whose panels are on the page side: transparent. Otherwise the panel colour. |
| `--ghost-hover` | paint | A secondary button under the pointer. | Flat bases whose panels are on the page side: the dialog colour mixed 10% toward the text. Otherwise the panel 5% lighter. |
| `--ghost-text` | colour | Text on a secondary button. | The link colour (flat) or the panel text (otherwise), moved until it reaches 4.7:1 on the button and its hover. |
| `--ghost-line` | colour | The border of a secondary button. | The same colour as --line. |
| **Delete buttons** | | | |
| `--danger-text` | colour | Delete buttons: the text. | palette.bad, moved until it reaches 4.7:1 on the panel (and on the dialog and the hover when the panels are on the page side). |
| `--danger-line` | colour | Delete buttons: the border. | The danger text when the panels are on the other side of the page; otherwise palette.bad moved until it reaches 3.2:1 on the dialog. |
| `--danger-hover` | colour | A Delete button under the pointer. | The hover colour when the panels are on the other side of the page; otherwise the dialog colour mixed 12% toward palette.bad. |
| **Inputs** | | | |
| `--input-bg` | colour | Text boxes, the search field, dropdowns, code snippets and report boxes. | The dialog colour mixed 30% toward black (dark page) or white (light page). |
| `--input-text` | colour | Text typed in those fields. | The text colour, moved until it reaches 4.7:1 on the input background. |
| `--input-line` | colour | The border of those fields. | The input background mixed 30% toward the input text. |
| **Status colours** | | | |
| `--panel-busy` | colour | Running-state text on panels ("Copying...") and the Building, Sending and Downloading pills. The 8 built-in themes that do not set it use --icon. | The same colour as --icon. |
| `--panel-warn` | colour | The Queued, Incomplete and Some failed pills (the .tag.stalled class). | palette.warn (default #e0a100), moved until it reaches 4.7:1 on the panel and on the Incomplete pill. |
| `--ok` | colour | Success text and the green status dot on the page and in dialogs. | palette.good, moved until it reaches 4.7:1 on the page and dialogs. |
| `--err` | colour | Error text and the red status dot on the page and in dialogs. | palette.bad, moved until it reaches 4.7:1 on the page and dialogs. |
| `--panel-ok` | colour | Success text on panels, a finished progress bar, the Downloaded, Built and Sent pills and the small OK chips. | palette.good (default #28a05a), moved until it reaches 4.7:1 on the panel and on the Downloaded pill. |
| `--panel-err` | colour | Error text on panels and the Failed and Stalled pills. | palette.bad (default #e5484d), moved until it reaches 4.7:1 on the panel and on the Failed pill. |
| **Dialogs and the tray** | | | |
| `--tray` | paint | The bar at the bottom while packages are selected. | palette.tray, else the page colour mixed 22% toward black or white; moved to the page side so the page text reads on it. Glossy bases: a gradient. |
| `--tray-line` | colour | The tray's top edge. | The tray colour mixed 22% toward the text. |
| `--dlg-bg` | colour | The background of dialogs and of the drop-a-file box. | palette.dialog (moved to the page side), else the page colour mixed 12% toward black (dark page) or white (light page). |
| `--backdrop` | colour | What dims the page behind a dialog. Give it some transparency. | rgba(0, 0, 0, 0.6) in a dark theme, rgba(20, 24, 40, 0.4) in a light one. |
| **Warnings** | | | |
| `--warn-bg` | colour | Warning boxes, banners and the small labels after a title (GAME, DLC). | The dialog colour mixed 22% (dark page) or 18% (light page) toward palette.warn. |
| `--warn-text` | colour | Text in those. | palette.warn (default #e0a100), moved until it reaches 4.7:1 on the warning background. |
| `--warn-line` | colour | The border of those. | The warning background mixed 40% toward the warning text. |
| **Shape and type** | | | |
| `--radius` | length | Corner rounding of buttons, fields and small things. 0 or up to 64px / 4rem / 4em. | The base look's own value. |
| `--radius-lg` | length | Corner rounding of panels, menus and dialogs. | The base look's own value. |
| `--font` | font | The typeface for the page. The pixel-font bases (ps1, ps1v2, snes) still set their buttons, title and dialog headings in their own pixel font. | The base look's own font stack. |

**Paired overrides.** Override a background token only together with everything readable on it:

| If you override | Also override (their readable text) |
|---|---|
| `--bg` | `--text` `--muted` `--link` `--ok` `--err` `--focus` |
| `--dlg-bg` | `--link` `--ok` `--err` `--text` `--muted` `--danger-text` |
| `--panel` | `--panel-text` `--panel-muted` `--panel-ok` `--panel-err` `--panel-busy` `--panel-warn` `--icon` `--danger-text` `--focus` |
| `--sel` | `--sel-text` `--sel-muted` |
| `--accent` | `--on-accent` |
| `--accent-2` | `--on-accent` |
| `--ghost-bg` | `--ghost-text` |
| `--ghost-hover` | `--ghost-text` |
| `--input-bg` | `--input-text` |
| `--warn-bg` | `--warn-text` |
| `--tray` | `--text` `--muted` `--link` |
| `--panel-head` | `--panel-muted` |
| `--hover` | `--panel-muted` |
| `--danger-hover` | `--danger-text` |

## R4. Value grammars and regular expressions

The server collapses runs of white space to one space and trims, then parses every value and writes it back from its parts. Anything else is refused. At most 300 characters per value, not counting the bytes of an embedded picture.

| Type | Grammar |
|---|---|
| colour | `#rgb` `#rgba` `#rrggbb` `#rrggbbaa`; `rgb()` `rgba()` `hsl()` `hsla()` with plain numbers, comma form `rgb(1, 2, 3, .5)` or space form `rgb(1 2 3 / .5)`, `%` where CSS allows; or `transparent`. Channels 0 to 255 (or 0 to 100 %), hue any number with optional `deg`, saturation and lightness 0 to 100, alpha 0 to 1 (or a percentage). No colour names, no `var()`, no `currentColor`. The palette takes the same but with no alpha and no `transparent`. Case does not matter. |
| gradient | `linear-gradient(` `[<n>deg` or `to <side> [<side>]` then `,]` 2 to 6 stops `)`, or `radial-gradient(` `[circle` or `ellipse` `[at <pos> [<pos>]]` or `at <pos> [<pos>]` then `,]` 2 to 6 stops `)`. A stop is a colour, then optionally a length or percentage (`px rem em %`; a bare `0` is fine). A position is `left right top bottom center` or a length. `to top bottom` (the same axis twice) is refused. |
| paint | A colour or a gradient. |
| image | `none`, or 1 to 3 comma-separated layers, each a gradient or `url(<ref>)`. The first layer is on top. |
| shadow | `none`, or 1 to 4 comma-separated shadows: `[inset] x y [blur [spread]] colour`; lengths in `px` (a bare `0` is fine), the blur not negative. |
| length | `0`, or a number with `px` (at most 64), `rem` or `em` (at most 4). Lower-case units. |
| font | 1 to 8 comma-separated families, at most 200 characters: bare names of letters, digits, spaces, `-` and `_` starting with a letter (generic names such as `sans-serif` and `system-ui` are bare names), or `"quoted"` names of up to 64 letters, digits, spaces, `.`, `-`, `_`. |
| `<ref>` in a `url()` | `data:image/(png\|jpeg\|webp\|gif\|svg+xml);base64,<data>` (at most 300 KB decoded, and the bytes must be that type), or `assets/<file>` in a folder theme. Nothing else: no `http:`, `https:`, `//`, absolute path, `..`, `javascript:`, `data:text/html`. |

Exact expressions the validator uses (copied from `server.js`):

```
id:
  /^[a-z0-9][a-z0-9-]{0,31}$/
names Windows will not make a file of (id, asset name):
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i
asset file name:
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
a number:
  /^-?(?:\d{1,7}(?:\.\d{1,8})?|\.\d{1,8})$/
a gradient position word or number:
  /^(?:left|right|top|bottom|center|-?(?:\d{1,4}(?:\.\d{1,4})?|\.\d{1,4})(?:%|px|rem|em)?)$/
hex colour:
  /^#([0-9a-f]+)$/
colour function (then split into three numbers and an optional alpha):
  /^(rgb|rgba|hsl|hsla)\(([^()]*)\)$/
length (then range-checked per token):
  /^(-?)(\d{1,6}(?:\.\d{1,4})?|\.\d{1,4})(px|rem|em|%)?$/
gradient wrapper:
  /^(linear-gradient|radial-gradient)\((.*)\)$/
linear gradient angle:
  /^-?(?:\d{1,4}(?:\.\d{1,4})?|\.\d{1,4})deg$/
linear gradient side:
  /^to (?:top|bottom|left|right)(?: (?:top|bottom|left|right))?$/
embedded picture or font:
  /^data:([a-z0-9+\/.-]{1,40});base64,([A-Za-z0-9+\/]*={0,2})$/i
asset reference:
  /^assets\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/
url() wrapper:
  /^url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s"'()]*))\s*\)$/i
quoted font family in --font:
  /^"([A-Za-z0-9 _.-]{1,64})"$/
bare font family in --font:
  /^[A-Za-z][A-Za-z0-9 _-]*$/
"fonts" family:
  /^[A-Za-z][A-Za-z0-9 _.-]{0,39}$/
"fonts" family names refused:
  /^(pixelchrome|serif|sans-serif|monospace|cursive|fantasy|system-ui|inherit|initial|unset|default)$/i
"fonts" weight:
  /^(?:[1-9]00|normal|bold)$/
characters refused in name, author, description and version (and < and > as well):
  /[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff\ufffd]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
characters refused in css:
  /[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff\ufffd]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
css selector characters:
  /^[A-Za-z0-9 _\-.#:,>+~\[\]="'*()^$|]+$/
css property name:
  /^(?:-?[a-z][a-z-]{0,63}|--[A-Za-z0-9_-]{1,64})$/
css string body:
  /^[\p{L}\p{N} _.,:%+\-\/()!?#*=~&|^$\[\]]*$/u
SVG content refused (a scanner, not one regular expression; it decodes entities and css escapes first):
  an element `script`, `foreignObject`, `iframe`, `embed` or `object`; `javascript:`, `vbscript:`, `data:text/html` or `<!ENTITY` anywhere; `on...=` event attributes; `@import`; a link (`href`, `src`, `to`, `from`, `by`, `values`, and `url()` in a style) to anything but `data:image/`; and a file that is not well-formed SVG (`is not an SVG picture`, `is not well-formed`).
```

## R5. CSS

Applies to the manifest's `css` and to a folder's `theme.css` (added after it). The compiler reads plain rules, writes them back rule by rule from what it understood, and prefixes each selector with `html[data-custom="<id>"]`.

- **No** at-rules, no nesting, no `<` anywhere, no backslash, at most 60 KB, 200 rules, 40 declarations a rule. Comments `/* ... */` are fine (except that a `<` inside is refused).
- **Selectors**: only the characters `A-Za-z0-9 _-.#:,>+~[]="'*()^$|`, at most 200 characters and 20 comma-separated parts. A `(` may follow only these pseudo-classes: `:not( :is( :where( :has( :matches( :any( :-webkit-any( :-moz-any( :nth-child( :nth-last-child( :nth-of-type( :nth-last-of-type( :lang( :dir(`.
- **Properties**: `/^(?:-?[a-z][a-z-]{0,63}|--[A-Za-z0-9_-]{1,64})$/`, never `behavior behaviour -moz-binding -ms-behavior binding -webkit-binding`.
- **Hiding forms** (a denylist: it refuses the common ways to hide or blank the page but cannot catch every one): A theme is meant to restyle the page, not hide it or change its words. Refused in every rule: `content` other than `""`, `none` or `normal`; `display: none` (and `display: contents` on `html`, `body` or `*`); `visibility: hidden` or `collapse`; `opacity` below 0.3 (also inside `filter: opacity()`); text under 8px (`em`, `rem` and `%` are measured against 14px); `scale` under 0.3; and `var()` in any of these properties. If a theme ever makes the page unusable, open the page with `?safe=1` at the end of its address (safe mode ignores custom themes for that visit) and remove the theme.
- **Values**: numbers with a unit of at most 8 letters, plain words, `#hex` colours (3, 4, 6 or 8 digits), quoted strings (at most 100 characters, single line, of letters, digits, spaces and `_ . , : % + - / ( ) ! ? # * = ~ & | ^ $ [ ]`), the operators `+ - * / ,`, and calls to the functions below. A colon, semicolon, brace, at sign, backslash, angle bracket or exclamation mark (except a trailing `!important`) outside a quoted string is refused.
- **Functions**: `rgb rgba hsl hsla calc var min max clamp linear-gradient radial-gradient conic-gradient repeating-linear-gradient repeating-radial-gradient url translate translateX translateY scale rotate blur drop-shadow brightness contrast saturate hue-rotate grayscale sepia invert opacity cubic-bezier steps`. Not available: `attr`, `env`, `image-set`, `matrix`, `skew`, `rotateX`, `scale3d`, `translate3d`, `repeating-conic-gradient`, `minmax`, `repeat`. `url()` takes only a `<ref>` (R4).
- Specificity: your selector gets `html[data-custom="<id>"]` in front, so it beats a plain base rule such as `[data-theme=nathan] h1`, but a base rule with a chain of `:not()` (the console looks' buttons, `nathan`'s button glow) outranks it: add `!important`.

## R6. Assets

- Types: `png jpg jpeg webp gif svg woff woff2 ttf otf`. Names `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` (letters, digits, dot, dash, underscore, starting with a letter or digit, at most 64 characters), and not a Windows device name; two names that differ only in capitals are refused. One level: `assets/<file>`.
- The file's bytes must be what its name says (a `.png` must start with the PNG signature). An SVG must contain `<svg` and pass the rules in core step 8.
- Limits: at most 24 files in the folder (`theme.json` and `theme.css` count), each at most 1.5 MiB, 4 MiB in all. A single file at most 1 MiB, measured on the manifest as the server writes it back.
- Pictures are for `--bg-image`, for `url()` in css, and for `logo` and `icons` (R1); fonts are for `"fonts"`. A font used as a picture, or a picture used as a font, is refused.
- The server rewrites `assets/<file>` to `themes/<id>/assets/<file>` (relative, so a reverse proxy under a sub-path works) and serves it with `nosniff` and, for SVG, a sandbox policy.

## R7. Readability pairs

The text-on-background pairs the page keeps. "required" pairs are guaranteed for every colour the page derives (the derivation aims at 7.1 or 4.7 so the minimum is met with room to spare); "extra" pairs are also in the report; "guard" is only the runtime guard. The derivation does not correct an explicit override; the report only lists it (and in a browser the runtime guard may still nudge that text colour up to 4.5:1, never higher and never `--focus`, so do not count on it). The preview measures small text at 4.5:1 whatever the pair's minimum is, and the derived `--sel-muted` is aimed at 4.7 so that it clears that line (core 5.2).

| Pair | Text | On | Minimum | Kind |
|---|---|---|---|---|
| Text on the page | `--text` | `--bg` | 7 | required |
| Muted text on the page | `--muted` | `--bg` | 4.5 | required |
| Links on the page | `--link` | `--bg` | 4.5 | required |
| Links in dialogs | `--link` | `--dlg-bg` | 4.5 | required |
| Text on panels | `--panel-text` | `--panel` | 7 | required |
| Muted text on panels | `--panel-muted` | `--panel` | 4.5 | required |
| Done text on panels | `--panel-ok` | `--panel` | 4.5 | required |
| Error text on panels | `--panel-err` | `--panel` | 4.5 | required |
| Busy text on panels | `--panel-busy` | `--panel` | 4.5 | required |
| Warning text on panels | `--panel-warn` | `--panel` | 4.5 | required |
| Icons on panels | `--icon` | `--panel` | 4.5 | required |
| Danger buttons on panels | `--danger-text` | `--panel` | 4.5 | required |
| OK text on the page | `--ok` | `--bg` | 4.5 | required |
| OK text in dialogs | `--ok` | `--dlg-bg` | 4.5 | required |
| Error text on the page | `--err` | `--bg` | 4.5 | required |
| Error text in dialogs | `--err` | `--dlg-bg` | 4.5 | required |
| Selected row text | `--sel-text` | `--sel` | 4.5 | required |
| Selected row, muted text | `--sel-muted` | `--sel` | 4.5 | required |
| Button text | `--on-accent` | `--accent` | 4.5 | required |
| Button text, hovered | `--on-accent` | `--accent-2` | 4.5 | required |
| Outline button text | `--ghost-text` | `--ghost-bg` | 4.5 | required |
| Outline button text, hovered | `--ghost-text` | `--ghost-hover` | 4.5 | required |
| Text in fields | `--input-text` | `--input-bg` | 4.5 | required |
| Warning box text | `--warn-text` | `--warn-bg` | 4.5 | required |
| Text in dialogs | `--text` | `--dlg-bg` | 4.5 | required |
| Muted text in dialogs | `--muted` | `--dlg-bg` | 4.5 | required |
| Text on the bottom bar | `--text` | `--tray` | 4.5 | required |
| Muted text on the bottom bar | `--muted` | `--tray` | 4.5 | required |
| Focus ring on the page | `--focus` | `--bg` | 3 | required |
| Focus ring on panels | `--focus` | `--panel` | 3 | required |
| Muted text on a list header | `--panel-muted` | `--panel-head` | 4.5 | extra |
| Muted text on a hovered row | `--panel-muted` | `--hover` | 4.5 | extra |
| Links on the bottom bar | `--link` | `--tray` | 4.5 | extra |
| Danger buttons, hovered | `--danger-text` | `--danger-hover` | 4.5 | extra |
| Done tag | `--panel-ok` | `--panel` (with the done pill tint over it) | 4.5 | extra |
| Failed tag | `--panel-err` | `--panel` (with the failed pill tint over it) | 4.5 | extra |
| Incomplete tag | `--panel-warn` | `--panel` (with the stalled pill tint over it) | 4.5 | extra |
| Working tag | `--panel-busy` | `--panel` (with the busy pill tint over it) | 4.5 | extra |
| Stopped tag | `--panel-muted` | `--panel` (with the stopped pill tint over it) | 4.5 | extra |
| Danger buttons in dialogs | `--danger-text` | `--dlg-bg` | 4.5 | guard |

## R8. Base looks in full

| `base` | Corners (radius / large) | Panels and buttons | Typeface | What it draws in colours of its own | Suits |
|---|---|---|---|---|---|
| `midnight` | 6px / 8px | flat (one colour) | system-ui | Nothing. Flat panels, plain buttons, no decoration. | Everything. The default. |
| `purple` | 6px / 8px | flat (one colour) | system-ui | Nothing; identical structure to `midnight` (only its own colours differ, and yours replace them). | Never: use `midnight`. |
| `oled` | 6px / 10px | flat (one colour) | system-ui | Soft lilac glows (`#c9a2ff`) on buttons, the progress bar, chips and status dots, a glow on the title, an inset ring on the selected row. | Near-black pages with lilac or purple accents. |
| `nathan` | 5px / 8px | flat (one colour) | system-ui | The same glows in terminal green (`#33ff66`), and a red glow on the error dot. | Black terminal themes with green accents. |
| `nes` | 2px / 3px | glossy (gradients, bevel) | Trebuchet MS / Segoe UI + a pixel face for buttons, title, headings | A warm grey console shell with a fine diagonal texture, a black stripe under the header, and a black-and-red badge; black borders with hard 2 px offset shadows, square corners on panels, buttons and fields; flat opaque bevels; the pixel typeface; pixelated images. | Boxy light grey looks. |
| `yoshisisland` | 12px / 16px | flat (one colour) | Comic Sans MS / Chalkboard SE + rounded fallbacks | A cream signboard header with a green grass fringe under it; drawn green outlines and soft drops on filled buttons; a hand-drawn sky of faint clouds and egg outlines behind the page; pill-shaped chips, tags and progress bars. | Light, warm, storybook looks. |
| `spookemon` | 8px / 12px | flat (one colour) | Georgia / Times New Roman | A soft violet halo on the title and the filled buttons, a glowing progress fill and status dots, a violet ring in place of panel shadows, and a hand-drawn night behind the page: faint fog, a bare branch and a pale moon. | Dark violet or ghostly night looks. |
| `win95` | 0px / 0px | flat (one colour) | MS Sans Serif / Tahoma | Four-tone bevels (white, black, light grey, mid grey) on buttons and sunken fields; a dotted focus outline; the Windows system font stack. | Grey, beige or teal desktop looks, light or dark. |
| `ps1` | 3px / 4px | glossy (gradients, bevel) | Trebuchet MS / Segoe UI + a pixel face for buttons, title, headings | A navy header band (`#2b3c93` to `#0a0f3d`) with a blue, red, green and pink stripe under it, and the four face-button shapes as a logo; near-black navy borders and hard offset shadows (`#05071a`); a pixel typeface on buttons, the title and dialog headings; face-button marks on some buttons; CRT scanlines over the whole page (1 px lines every 3 px at 14 % black). | Dark navy or blue pages. Not light pages: the scanlines show. |
| `ps1v2` | 6px / 8px | glossy (gradients, bevel) | Trebuchet MS / Segoe UI + a pixel face for buttons, title, headings | A violet header band (`#5647a8` to `#2c2560`) with a violet, red, blue and gold stripe; near-black violet borders and hard offset shadows (`#17142e`); the pixel typeface. No logo, no scanlines. | Dark violet or navy pages. |
| `snes` | 6px / 8px | glossy (gradients, bevel) | Trebuchet MS / Segoe UI + a pixel face for buttons, title, headings | The same violet band and stripe as `ps1v2`; borders and offset shadows `#16112b`; the pixel typeface; chunky checkboxes with a white tick. | Lavender or violet pages, light or dark. |
| `dreamcast` | 14px / 18px | glossy (gradients, bevel) | Trebuchet MS / Segoe UI | A blue, red, light-blue and orange stripe under the header; faint white concentric rings at the top right (16 % opacity); soft glossy button shadows. | Blue and orange looks, light or dark. |
| `wii` | 16px / 22px | glossy (gradients, bevel) | Trebuchet MS / Segoe UI | A blue, red, green and yellow stripe under the header; a mirror reflection under the title; pill-shaped buttons, chips and search field; a pale blue wave along the bottom of the page. | Light, airy themes. |
| `itsmemario` | 10px / 14px | glossy (gradients, bevel) | Trebuchet MS / Segoe UI | A blue, red, green and yellow stripe; a 3D title; a green and brown ground strip along the bottom, a tree at the right and cloud shapes, drawn on any page; black borders with hard 3 px offset shadows on buttons and panels. | A sky-blue look only. Avoid it otherwise. |

## R9. What each preview image shows

| File | Screen | Look for |
|---|---|---|
| `01-main.png` (`-2`, `-3` for the rest of the page) | The library list: header, banners, progress bars, search, toolbar, folders, rows, chips, footer. | Title and header buttons stand out from the page; the warning banner is readable; progress fills show against their tracks; the search field and toolbar have an edge; folder icons, chips and the footer are legible; a picture behind the page does not fight the text. |
| `02-selected.png` | Two rows selected, the bottom tray showing. | Selected rows are clearly different from the others and their text is legible; checkbox ticks show; the tray is separated from the page; Delete, Rename, Copy links and Send are distinguishable; the disabled Info button is dimmed but readable. |
| `03-dump.png` | A game dump's card and its build options (starts at the breadcrumb and its Up button). | Text on the card, the breadcrumb and the build options is legible. |
| `04-history.png` (`-2` to `-5`) | History with every Details open. | The Sent, Failed, Downloaded, Incomplete and Built pills differ by colour and by word; labels differ from their values. |
| `05-activity.png` | Activity: progress bars, Stop and Cancel buttons. | Bars and buttons are visible; the paused and finished entries differ. |
| `06-themes.png` | The Themes dialog. | Your theme's row: its swatch (page, panels, accent) matches the theme and its badges are readable. |
| `07-setup.png` | Setup and network. | The good, warning and bad check marks are distinguishable. |
| `08-maker.png` | The theme maker (your theme opened for editing). | Form fields are legible on the dialog background. Skip it unless you changed the dialog colours. |
| `09-install.png` | The Add a theme dialog, as when the file is dropped on the page: name, badges, six swatches, the readability table, warnings, the Try it / Install for every device / This browser only buttons. | Swatches match the theme; a failing row is drawn in the error colour. |

Options not in the core: `--pages <n>` (most screens of any long view), `--keep-temp` (leave the scratch folders), `--keep-bg` (also save each text-hidden capture as `<name>.bg.png`, what the contrast is measured against), `--verbose`. `preview.json` in `--out` holds the same findings for scripts: `failures` (each with a `kind`), `verdict`, `shots`, `notReached`, `notTaken`.

## R10. Raw API and installing on a running server

The check without the tool, against a running server (`curl` in a POSIX shell; add `-u shadow:PASSWORD` if the server has a password):

```
printf '{"theme":%s}' "$(cat sunset.json)" | curl -s -X POST http://127.0.0.1:12801/api/themes/check -H 'Content-Type: application/json' --data-binary @-
```

It answers `{"ok":true,"theme":{...},"warnings":[...]}` (status 200) or `{"ok":false,"problems":[...]}` (status 400) and writes nothing. For a folder the body is `{"files":{"theme.json":"<text>","theme.css":"<text>","assets/grid.svg":"<base64>"}}`. The readability numbers come from the page's engine, so the raw call does not print them: use `check.js`.

Installing (only when the requester gives an address). A server keeps themes in `<config folder>/themes/`; a hand-placed file or folder there is picked up within a second. Through the API (same origin rules as the page; `-u shadow:PASSWORD` when a password is set):

```
printf '{"theme":%s,"replace":true}' "$(cat deep-sea.json)" | curl -s -X POST http://HOST:12801/api/themes -H 'Content-Type: application/json' --data-binary @-
curl -s -X DELETE http://HOST:12801/api/themes/deep-sea
```

`POST /api/themes` answers 200 `{ok, theme, warnings}`, 409 `{error: "exists"}` when the id exists and `replace` is not `true`, 403 when the config folder is not writable, 400 `{ok:false, problems}` when the theme is refused. `GET /api/themes` lists installed themes (a light summary each: id, name, author, description, version, base, mode, palette, form, bytes, hasFonts, hasCss, hasTokens, editable) and the ones it refused (`rejected`); `GET /api/themes/<id>` returns one in full with its cleaned manifest as `source`. Making a theme the default for devices that have not chosen: `POST /api/settings` with `{"defaultTheme":"<id>"}`.

## R11. Validator messages

Each message below was produced by the real validator. The first two columns are what you wrote and what the server said; the third is the fix. (A message that starts `The request` is what a posted manifest gets; `check.js` reads the file and shows its own wording for the same fault.)

| What went wrong | What you wrote | What the server says | Fix |
|---|---|---|---|
| No "shadowtheme": 1 | `no such key` | "shadowtheme": 1 is missing (it says the file is a theme) | Add "shadowtheme": 1 as the first key. |
| No name | `no "name"` | name is required | Add a "name" of 1 to 40 characters. |
| Name too long | `"name": 41 characters` | name is longer than 40 characters | Shorten it to 40 characters or fewer. |
| Angle bracket or control character in a text field | `"name": "a<b"` | name has a character that is not allowed (control characters and angle brackets) | Remove < and >, control characters and zero-width characters from name, author, description and version. |
| Built-in id | `"id": "midnight"` | "midnight" is the name of a built-in theme: use another "id" | Use another id. The built-in ids are ps1 ps1v2 midnight purple nes snes dreamcast wii itsmemario yoshisisland oled nathan win95 spookemon. |
| Id not a slug | `"id": "Deep Sea"` | id "Deep Sea" must be 1 to 32 lower-case letters, digits or dashes, starting with a letter or digit | Lower-case letters, digits and dashes only, starting with a letter or digit, at most 32 characters: "deep-sea". |
| Windows device name as id | `"id": "con"` | "con" is a name Windows does not allow for a file: use another "id" | Use another id (con prn aux nul com1-9 lpt1-9 are refused). |
| Unknown base | `"base": "flat"` | base must be one of ps1, ps1v2, midnight, purple, nes, snes, dreamcast, wii, itsmemario, yoshisisland, oled, nathan, win95, spookemon | Use one of the fourteen built-in ids. |
| Bad mode | `"mode": "auto"` | mode must be "dark" or "light" | Write "dark" or "light", or leave mode out. |
| Colour name in the palette | `"accent": "red"` | palette accent: "red" is not a colour: use #rrggbb, rgb(), hsl() or transparent | Write #rrggbb (or rgb() / hsl()). |
| Alpha in the palette | `"accent": "#ff7a4580"` | palette accent: "#ff7a4580" has an alpha part, which is not allowed here | The palette takes opaque colours only. Alpha is allowed in tokens. |
| transparent in the palette | `"accent": "transparent"` | palette accent: transparent is not allowed here | Use a real colour. |
| Token not in the catalogue | `"--accent-color": "#f80"` | "--accent-color" is not a token a theme can set | Use the exact name from the catalogue (--accent). |
| Colour name in a token | `"--bg": "black"` | token --bg: "black" is not a colour: use #rrggbb, rgb(), hsl() or transparent | Write #rrggbb. |
| var() in a token | `"--bg": "var(--panel)"` | token --bg: "var(--panel)" is not a colour: use #rrggbb, rgb(), hsl() or transparent | Write the colour itself. |
| Length without a unit | `"--radius": "10"` | token --radius: "10" needs a unit | Write 10px. |
| Length too large | `"--radius": "80px"` | token --radius: "80px" is too large (at most 64px) | At most 64px (4rem, 4em). |
| Gradient with one stop | `"--panel": "linear-gradient(#111)"` | token --panel: a gradient needs 2 to 6 colour stops | Give 2 to 6 colour stops. |
| Gradient angle without deg | `"--accent": "linear-gradient(90, #f80, #f40)"` | token --accent: "90" is not a colour: use #rrggbb, rgb(), hsl() or transparent | Write 90deg. |
| Shadow missing its colour | `"--panel-shadow": "0 1px 3px"` | token --panel-shadow: "3px" is not a colour: use #rrggbb, rgb(), hsl() or transparent | End every shadow with a colour. |
| Font name with a semicolon | `"--font": "\"a;b\""` | token --font: "?a;b?" is not a font name (letters, digits, spaces, - and _; quote a name with a dot) | Family names use letters, digits, spaces, . - _ only. |
| Picture from the internet | `"--bg-image": "url(https://x.test/a.png)"` | token --bg-image: url("https://x.test/a.png") is not allowed: only a picture embedded as data: or a file in assets/ can be used | Embed it as data:, or make a folder theme and use assets/<file>. |
| assets/ in a single file | `"--bg-image": "url(assets/a.png)"` | token --bg-image: assets/a.png cannot be used in a single file: embed the picture as a data: URL, or make a folder theme | Make it a folder theme, or embed the picture as a data: URL. |
| Too many image layers | `"--bg-image": four layers` | token --bg-image: at most 3 background layers | At most 3 layers. |
| Nothing to apply | `{"shadowtheme": 1, "name": "T"}` | a theme needs at least one of palette, tokens or css | Add a palette (or tokens, or css). |
| At-rule in css | `"css": "@media ..."` | css: at-rules (@import, @media, @font-face, ...) are not allowed | Write plain rules only. There is no @media, @keyframes, @font-face or @import. |
| Nested rule in css | `"css": "h1 { .a { } }"` | css: rules inside rules are not allowed | Write each rule on its own, flat. |
| Function not on the list | `"css": "h1 { width: attr(x) }"` | css: the function attr() is not allowed | Use only the listed functions. |
| Colon in a css value | `"css": "h1 { color: a:b }"` | css: a colon is not allowed in a value (no backslash, braces, semicolon, at sign, colon or angle brackets outside quotes) | Values may not contain a colon outside a quoted string. |
| Backslash in css | `"css": "h1 { content: \"\\41\" }"` | css: a backslash in a string is not allowed | No backslashes anywhere in css. |
| css with an unclosed brace | `"css": "h1 { color: #fff"` | css: a { is never closed | Close every brace. |
| Font family already used by the page | `"family": "serif"` | font 1: "serif" is a name the page already uses: pick another | Pick a name of your own. |
| Font weight not valid | `"weight": "heavy"` | font 1: weight must be 100 to 900, normal or bold | Write 100 to 900 (in hundreds), normal or bold. |
| Five fonts | `"fonts": five entries` | at most 4 fonts | At most 4. |
| Asset used but missing | `"--bg-image": "url(assets/nope.png)"` | token --bg-image: assets/nope.png is used but is not in the theme's assets folder | Put the file in assets/ or fix the name. |
| File is not the type its name says | `assets/a.png holding text` | assets/a.png is not really a PNG file | Export a real PNG (or JPEG, WebP, GIF, SVG). |
| SVG with script or a link | `assets/a.svg with <script>` | assets/a.svg has script or a link to somewhere else in it | Plain shapes only: no script, foreignObject, on... attributes, @import, or href/src to another address. |
| Asset name not allowed | `assets/my file.png` | "my file.png" is not a name an asset can have | Letters, digits, . - _ only, starting with a letter or digit, at most 64 characters. |
| Font used as a picture | `"--bg-image": "url(assets/f.woff2)"` | token --bg-image: assets/f.woff2 is not a picture (png, jpg, webp, gif, svg) | Pictures go in --bg-image and css url(); fonts go in "fonts". |
| A key given twice | `"name" twice in one object` | The request has the key "name" more than once   (in a themes folder: has the key "name" more than once) | Delete the repeated key. JSON.parse would silently keep the last one; the server refuses the file. |
| Not valid JSON (comment, trailing comma, single quotes) | `{"shadowtheme": 1,}` | The request is not valid JSON | Strict JSON: double quotes, no comments, no trailing commas. |

Warnings (the theme is still accepted):

| Cause | Warning | Fix |
|---|---|---|
| Unknown top-level key (ignored) | "extra" is not part of the theme format and was ignored | Remove it, or check the spelling. |
| Unknown palette key (ignored) | palette "sparkle" is not a colour the theme format knows and was ignored | Remove it, or check the spelling (surface2 is known but has no effect). |
| No id in the manifest (posted or dropped without one) | no "id" given, using "t" | Write the "id" yourself. |

Messages from `check.js` itself, before the server sees anything:

| Message | Cause and fix |
|---|---|
| `<file> is not valid JSON: ...` | A comma, quote or bracket is wrong. `check.js` prints the position. |
| `<file> is JSON, but not a ShadowPKG theme: it has no "shadowtheme": 1 in it.` | Add `"shadowtheme": 1`. |
| `That is not a theme. A theme is one .json file, or a folder with a theme.json in it.` | Wrong path or file type. |
| `the file has the key "..." more than once. Dropping it on the page works (the last value is kept), but the server does not use a file like this from its themes folder` | A key appears twice in one object. Delete one. |
| `engine bug: N pair(s) worked out from the palette fail (...)` | Not a mistake of yours. Change the palette until the pair passes, and mention it. |
| `could not start the scratch server: port N (from --port) is already in use ...` | Give another `--port`, or leave it out. |
| `--port is for the scratch server, and --server asks a server that is already running ...` | Use one or the other. |

## R12. Frequent mistakes

1. A colour name (`red`, `black`), `var(--x)` or `currentColor` where a colour goes. Write `#rrggbb`.
2. `http://` or `https://` in a `url()`. Nothing may load from the network.
3. `assets/...` in a single `<id>.json`. Embed as a base64 `data:` URL, or make a folder.
4. An `id` that is a built-in (`midnight`, `ps1`, `wii`...) or has capitals, spaces or underscores.
5. `@media`, `@keyframes`, `@import` or `@font-face` in css. There is no way to write those; use tokens and plain rules.
6. More than 6 gradient stops, more than 3 image layers, more than 4 shadows, more than 4 fonts, more than 8 font families.
7. Alpha in the palette (`#rrggbbaa`, `rgba(...,0.5)`, `transparent`). Alpha is for tokens only.
8. A length with no unit (`10`), a gradient angle with no `deg` (`90`), a shadow with no colour.
9. Overriding `--panel` (or `--bg`, `--sel`, `--accent`...) without the tokens readable on it, and then reading only "PASS" rows that were derived from the old value.
10. `surface2` in the palette. It is accepted and does nothing.
11. A comment, a trailing comma, single quotes or a repeated key in the JSON.
12. Writing all seeds as mid-tones (lightness 40 to 60 %): the page moves them and the theme looks nothing like the request.
13. A `dark` background with `"mode": "light"` (or the reverse).
14. A picture drawn with big, bright shapes behind the page: the text over it fails in the preview while `check.js` is happy.
15. `!important` on a colour that the page derives: it also hides your colour from the readability report. Use it only to beat a base look's rule.
16. Squaring the corners with `--radius` alone: the filter chips, status pills, progress bars and small chips keep their rounding (core 5.5).

## R13. More worked examples

Each was run through the real server before it went in this file.

### R13.1 A terminal theme on the flat `midnight` look

**Request:** "An amber terminal theme, square corners, monospace." Base `midnight` (no green, so `nathan`'s glows would clash, core 5.4). Seeds from an amber-on-black palette: page `#0a0703`, surface `#171007`, text `#ffc266` (saturation 100 %: the text band is advice, and the seeds come out unmoved because the contrast holds), accent `#ffb000`. `--radius` and `--radius-lg` `0`; a monospace stack; `--sel-muted` `#efb55c` (90 % text + 10 % the derived selection `#614305`, 4.94:1 on it, a little stronger than the derived one); three css rules: the pills squared (they ignore `--radius`), a glow on the title, a bar on the selected row.

`terminal-midnight.json`:

```json
{
  "shadowtheme": 1,
  "id": "terminal-midnight",
  "name": "Terminal Midnight",
  "description": "Amber-phosphor terminal on the flat midnight look: black page, monospace, square corners.",
  "version": "1.0",
  "base": "midnight",
  "mode": "dark",
  "palette": {
    "background": "#0a0703",
    "surface": "#171007",
    "text": "#ffc266",
    "accent": "#ffb000",
    "good": "#4cd7b4",
    "bad": "#ff6b57",
    "warn": "#ffc857"
  },
  "tokens": {
    "--radius": "0",
    "--radius-lg": "0",
    "--font": "\"Cascadia Mono\", Consolas, Menlo, \"DejaVu Sans Mono\", \"Courier New\", monospace",
    "--sel-muted": "#efb55c"
  },
  "css": ".chk.filter-chip, .chip, .dl .tag, .pbar, .pbar i { border-radius: 0; }\nh1 { text-shadow: 0 0 8px rgba(255, 176, 0, 0.5); }\n.row.sel { box-shadow: inset 3px 0 0 #ffb000; }"
}
```

Check:

```
$ node tools/themes/check.js terminal-midnight.json
theme: terminal-midnight.json (single file)

ACCEPTED: Terminal Midnight
  id           terminal-midnight
  name         Terminal Midnight
  base         midnight
  mode         dark
  form         file
  bytes        824
  version      1.0
  description  Amber-phosphor terminal on the flat midnight look: black page, monospace, square corners.
  uses         palette (7 colours), tokens (4), css

readability: 47 pairs, all at or above their minimum
  pair                                  ratio  min  result  from
  Muted text on the page                 5.30  4.5  PASS    derived
  Selected row, muted text               4.94  4.5  PASS    override (--sel-muted)
  Muted text in dialogs                  5.33  4.5  PASS    derived
  Muted text on the bottom bar           5.36  4.5  PASS    derived
  Muted text on a list header            5.34  4.5  PASS    derived
  Stopped tag                            4.76  4.5  PASS    derived

exit 0: valid, and every readability pair passes
(41 more rows, all PASS and derived, are left out of this listing)
```

The preview: black page, amber monospace text, square panels, buttons, filter chips and pills, an amber bar on the selected row with legible text, Sent (teal) and Failed (red) pills differing by colour and word. The only findings were the page's own (the `hidden` chip and the footer credits).

### R13.2 A high-contrast light theme (low vision)

**Request:** "A clear, high-contrast light theme; edges must be easy to see." Starter "Clear day" (page luminance 0.763, contrast 1.29 with the white surface), plus the edge tokens, the dialog seed and `--sel-muted` from core 5.1 and 5.2.

`high-contrast-light.json`:

```json
{
  "shadowtheme": 1,
  "id": "high-contrast-light",
  "name": "High Contrast Light",
  "description": "Blue-grey page, white panels with dark edges and a shadow; for low vision.",
  "version": "1.0",
  "base": "midnight",
  "mode": "light",
  "palette": {
    "background": "#dce3ed",
    "surface": "#ffffff",
    "text": "#0e1620",
    "accent": "#1d4ba8",
    "dialog": "#ffffff",
    "good": "#107171",
    "bad": "#b0381b",
    "warn": "#8a5c00"
  },
  "tokens": {
    "--line": "#606872",
    "--ghost-line": "#373f49",
    "--input-line": "#373f49",
    "--panel-shadow": "0 2px 6px rgba(14, 22, 32, 0.25)",
    "--sel-muted": "#202934"
  }
}
```

Check:

```
$ node tools/themes/check.js high-contrast-light.json
theme: high-contrast-light.json (single file)

ACCEPTED: High Contrast Light
  id           high-contrast-light
  name         High Contrast Light
  base         midnight
  mode         light
  form         file
  bytes        651
  version      1.0
  description  Blue-grey page, white panels with dark edges and a shadow; for low vision.
  uses         palette (8 colours), tokens (5)

readability: 47 pairs, all at or above their minimum
  pair                                  ratio  min  result  from
  Muted text on the page                 5.32  4.5  PASS    derived
  OK text on the page                    4.74  4.5  PASS    derived
  Error text on the page                 4.74  4.5  PASS    derived
  Selected row, muted text               9.48  4.5  PASS    override (--sel-muted)
  Warning box text                       4.73  4.5  PASS    derived
  Stopped tag                            4.91  4.5  PASS    derived

exit 0: valid, and every readability pair passes
(41 more rows, all PASS and derived, are left out of this listing)
```

The preview: white panels with dark edges and a soft shadow on a blue-grey page, dark row rules, outlined buttons and fields that are easy to see, selected rows in pale blue with dark quiet text. The only findings were the page's own (5). The dark counterpart (`recipes` starter "Black, high contrast" with the values in core 5.1) previews the same way: a black page, panels ringed in grey `#999999`, white text, a yellow accent, one page-own finding (the `hidden` chip).

### R13.3 A light theme on a non-default base

**Request:** "A light lavender theme in the SNES console look."

1. Facts: name Lavender; id `lavender`; light; single file. The request names a console look, so base `snes`.
2. Base consequences (R8): SNES draws a violet header band (`#5647a8` to `#2c2560`) with a four-colour stripe, near-black violet borders and offset shadows, a pixel font on buttons and headings, and gloss on panels and buttons. All of that stays. A lavender palette (hue 253) goes with the violet band, so nothing needs neutralising. `snes` is glossy, so the glossy accent band applies.
3. Mode `light`. Background `#eeeaf8`, luminance 0.838; surface `#ffffff`: contrast 1.18; text `#241d38`: 13.6:1.
4. Accent `#5233c4`, luminance 0.0815. The glossy light rule is at most 0.09, so it passes: its two gloss stops `#6043ce` and `#4a2eb0` both host white button text. An accent that is fine on a flat base, such as `#6f54d4` (luminance 0.145), lies inside the forbidden glossy band (0.09 to 0.32) and the page moves it on a glossy base (here to `#7157d5` at its lighter stop).
5. Status colours from the light row. No token overrides, no CSS, no pictures.

`lavender.json`:

```json
{
  "shadowtheme": 1,
  "id": "lavender",
  "name": "Lavender",
  "author": "ShadowPKG agent guide",
  "description": "Light theme on the SNES look: pale lavender page, white panels, violet accent.",
  "version": "1.0",
  "base": "snes",
  "mode": "light",
  "palette": {
    "background": "#eeeaf8",
    "surface": "#ffffff",
    "text": "#241d38",
    "accent": "#5233c4",
    "good": "#107171",
    "bad": "#b0381b",
    "warn": "#8a5c00"
  }
}
```

Check:

```
$ node tools/themes/check.js lavender.json
theme: lavender.json (single file)

ACCEPTED: Lavender
  id           lavender
  name         Lavender
  base         snes
  mode         light
  form         file
  bytes        448
  author       ShadowPKG agent guide
  version      1.0
  description  Light theme on the SNES look: pale lavender page, white panels, violet accent.
  uses         palette (7 colours)

readability: 46 pairs, all at or above their minimum
  pair                              ratio  min  result  from
  Muted text on the page             5.35  4.5  PASS    derived
  Danger buttons, hovered            5.03  4.5  PASS    derived
  Failed tag                         4.70  4.5  PASS    derived
  Incomplete tag                     4.72  4.5  PASS    derived
  Stopped tag                        4.70  4.5  PASS    derived

exit 0: valid, and every readability pair passes
(41 more rows, all PASS and derived, are left out of this listing)
```

The preview showed the violet header band and stripe, white gloss panels on a lavender page, pixel-font buttons, and selected rows in pale violet with dark text. At phone width the pixel font clips the long status lines and the console name, as it does in the built-in SNES look: that belongs to the base. Findings: the page's own (footer credits, `hidden` chip, banner `Details` button) and the selected row's small text at 4.35 to 4.40:1.

### R13.4 A folder theme with a hand-drawn SVG and CSS

**Request:** "A dark drafting-table theme called Blueprint: a faint grid behind the page, a yellow accent."

1. Facts: name Blueprint; id `blueprint`; dark; base `midnight`. It needs a hand-drawn SVG and CSS, so a **folder**: `theme.json`, `theme.css`, `assets/grid.svg`.
2. Palette: background `#0a2540` (hue 210, luminance 0.018); surface `#0f3459`, contrast 1.23; text `#e8f2ff`, 13.7:1. Accent `#ffd166`, luminance 0.678. Status colours from the dark row.
3. Picture: `grid.svg` is an 80 x 80 tile of plain `<path>` lines: minor lines every 20 units at 7 % opacity, major lines at the tile edge at 16 %. It is referred to as `assets/grid.svg`; the second image layer is a vertical gradient so the page is not flat blue. `--bg-image` lists the tile first (drawn on top).
4. The derived selection colour, a yellow accent mixed into a blue panel, is an olive grey (`#5c665d`); its derived quiet text is `#e1e5e8` (4.72:1), and `--sel-muted` is set to the slightly cooler `#dbe3e8` (4.60:1) by choice, not need.
5. CSS (four rules, in `theme.css`): a spaced uppercase title, a dashed line under the header, a faint outline on panels and the toolbar, and a yellow bar on the selected row. No layout properties, no at-rules.

`blueprint/theme.json`:

```json
{
  "shadowtheme": 1,
  "id": "blueprint",
  "name": "Blueprint",
  "author": "ShadowPKG agent guide",
  "description": "Drafting-table blue with a faint grid behind the page and a yellow accent.",
  "version": "1.0",
  "base": "midnight",
  "mode": "dark",
  "palette": {
    "background": "#0a2540",
    "surface": "#0f3459",
    "text": "#e8f2ff",
    "accent": "#ffd166",
    "good": "#4cd7b4",
    "bad": "#ff6b57",
    "warn": "#ffc857"
  },
  "tokens": {
    "--bg-image": "url(assets/grid.svg), linear-gradient(180deg, #0d3157, #0a2540)",
    "--sel-muted": "#dbe3e8"
  }
}
```

`blueprint/theme.css`:

```css
/* Blueprint: drafting-table touches. Each rule is scoped to this theme by the server. */
h1 { letter-spacing: .14em; text-transform: uppercase; }
header { border-bottom: 1px dashed rgba(156, 201, 255, .45); padding-bottom: 10px; }
.panel, .toolbar { outline: 1px solid rgba(156, 201, 255, .2); outline-offset: -1px; }
.row.sel { box-shadow: inset 3px 0 0 #ffd166; }
```

`blueprint/assets/grid.svg`:

```xml
<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80">
  <path d="M0 20H80M0 40H80M0 60H80M20 0V80M40 0V80M60 0V80" fill="none" stroke="#9cc9ff" stroke-opacity=".07" stroke-width="1"/>
  <path d="M0 .5H80M.5 0V80" fill="none" stroke="#9cc9ff" stroke-opacity=".16" stroke-width="1"/>
</svg>
```

Check (a folder: the tool reads the folder around `theme.json`):

```
$ node tools/themes/check.js blueprint
theme: blueprint (folder theme, 3 files)

ACCEPTED: Blueprint
  id           blueprint
  name         Blueprint
  base         midnight
  mode         dark
  form         folder
  bytes        1272
  author       ShadowPKG agent guide
  version      1.0
  description  Drafting-table blue with a faint grid behind the page and a yellow accent.
  uses         palette (7 colours), tokens (2), css

readability: 47 pairs, all at or above their minimum
  pair                                  ratio  min  result  from
  Error text on panels                   5.11  4.5  PASS    derived
  Danger buttons on panels               6.11  4.5  PASS    derived
  Selected row, muted text               4.60  4.5  PASS    override (--sel-muted)
  Muted text on a list header            4.88  4.5  PASS    derived
  Failed tag                             4.72  4.5  PASS    derived
  Stopped tag                            4.72  4.5  PASS    derived

exit 0: valid, and every readability pair passes
(41 more rows, all PASS and derived, are left out of this listing)
```

The preview showed a faint grid over a blue page, a yellow title, a dashed header rule and the yellow selection bar; at phone width nothing was cut off beyond what the built-ins also cut. The only findings left were the page's own. "Try it" in the page does not show `assets/` pictures until the theme is installed; the preview installs it first.

## R14. Prompt template

A person hands this to an agent. Fill the angle brackets; delete a line to accept its default.

```
Read docs/THEMES-FOR-AGENTS.md in the ShadowPKG repository at <path to the checkout> and follow it exactly.

Make a ShadowPKG theme called "<name>".
Look: <mood in a few words, or a brand colour like #ff7a45, or the path of a reference picture>
Light or dark: <dark | light>                  (default: dark)
Base look: <midnight | ps1 | ps1v2 | nes | snes | dreamcast | wii | itsmemario | yoshisisland | oled | nathan | win95 | spookemon>   (default: midnight)
Shape: <single file | folder>                  (default: single file)
Pictures or fonts: <none | paths to the files I supply>   (default: none)
Write it to: <absolute directory>              (default: the current directory)
Install it: <no | on the server at http://host:port>   (default: no)

Do not change anything else in the repository. When the theme is finished, answer in the format at the top of the guide (FINAL MESSAGE FORMAT), and nothing else.
```

For several themes: "Make <n> themes: <a one-line brief for each>. Use a different id for each. Finish with a table of id, base, mode and check result."
