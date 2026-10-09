# Making ShadowPKG themes: a guide for AI agents

For an AI agent with file tools and a shell that must make a ShadowPKG theme (format 1, `"shadowtheme": 1`). This CORE file is complete (about 18k tokens: read it once, in one pass). The exhaustive reference (every regular expression, the full token table, every validator message, more worked examples) is `docs/THEMES-REFERENCE.md`: open a section (R1 to R14) only when this file sends you there. Where this file and `docs/THEMES.md` (the human guide) disagree, this file follows the code. Do not ask the requester a question that section 2 answers with a default. Companions: `docs/theme.schema.json` (JSON Schema; do not read it, it is 80 KB) and `docs/theme-tokens.json` (48 tokens).

## FINAL MESSAGE FORMAT

Your last message is read by a person or a script. Use exactly these lines, one line each where you can, `none` where nothing applies, and do not paste the files. For several themes give one block per theme, then a table of id, base, mode, check exit and path.

```
THEME:        <name> (id <id>)
FILE:         <absolute path of the file, or of the theme folder>
FORM:         <single file | folder, N files>
BASE / MODE:  <base> / <dark | light>
PALETTE:      background <#>, surface <#>, text <#>, accent <#>, good <#>, bad <#>, warn <#>
OVERRIDES:    none | <token>: <value> (<why>); ...
CSS:          none | <n> rules (<why>)
ASSETS:       none | <file> (<bytes>): <what it is and where it came from>
CHECK:        node tools/themes/check.js <path> -> exit <0 | 2>; <n> pairs, <n> failing
PREVIEW:      <folder of PNGs> (desktop and phone) | not run: <reason>
LOOKED AT:    <the screens you opened and what you saw, one sentence>
FINDINGS:     none | <the VERDICT line of preview.js, and any NEW finding you left and why>
COMPROMISES:  none | <seeds the page moved, base-look decorations kept, anything asked for that a theme cannot do>
ASSUMPTIONS:  none | <every default you assumed from section 2>
```

## QUICK PATH (a simple request, twelve lines)

1. Fill section 2 from the request; assume the default for anything missing; never block.
2. Base: `midnight` unless a look is named (step 2). Mode: `dark` unless asked (step 3).
3. Seeds: the nearest starter palette in step 4, or build from a brand colour (step 6). Write all four seeds.
4. Status colours: the step 5 row for the mode. Write all seven colours.
5. Write `<id>.json` shaped like example 8 (a folder only for fonts, big pictures or long CSS), in the directory the requester named.
6. `--sel-muted` is derived at 4.7:1 and needs no override (5.2). Near-black pages and wide gaps are fine (5.1, 5.3).
7. `node tools/themes/check.js <path>` until it exits 0 (6.1). Piped, the last line `exit N: ...` is the truth.
8. `node tools/themes/preview.js <path> --out <folder> --phone` (about a minute). Read its last lines: FINDINGS, then VERDICT.
9. Open `01-main.png`, `02-selected.png`, `04-history.png` and their `-phone` versions.
10. Fix every `[NEW]` finding (6.2), then repeat 7 and 8. `[page-own]` findings need no fix.
11. Tick the definition of done (section 7).
12. Write the final message above.

## 1. Purpose and scope

1. ShadowPKG is a self-hosted web app (one HTML page, one Node server) that serves PlayStation packages. A **theme** changes how the page looks: colours, page background, corner rounding, typeface, optionally a few CSS rules and pictures. It is data: one JSON file, or one folder.
2. You give four colours (background, surface, text, accent) and three status colours. The page derives 48 CSS variables ("tokens") from them and moves a derived colour that would leave text unreadable. Your work is choosing colours, a base look and, only when needed, overrides, pictures, fonts and CSS.
3. **You make theme files and nothing else.** Never edit `server.js`, `index.html`, `README.md`, the Docker templates, `docs/`, `tools/`, `examples/`, or another theme. Run no git commands in the ShadowPKG checkout unless asked. Keep scratch files in the system temp folder and remove them.
4. If a request needs what a theme cannot do (a new button, a layout change, script, animation, an internet picture), say so in COMPROMISES and deliver the closest theme inside the rules. Never edit the app.
5. **Done** means: `check.js` exits 0, you looked at the preview (checklist in 6.2), every `[NEW]` finding is fixed or explained, and the final message has the shape above.

## 2. Request checklist

Get each fact from the requester, or assume the default and list it in ASSUMPTIONS.

| Fact | What to settle | Default when silent |
|---|---|---|
| Name | Shown in the picker, 1 to 40 characters, no `<` `>` | Two words from the mood ("Deep Sea"). |
| Id | Identity and file name | The name lower-cased, each run of characters outside `a-z0-9` one dash, dashes trimmed, cut to 32. If empty, a built-in id (`ps1 ps1v2 midnight purple nes snes dreamcast wii itsmemario yoshisisland oled nathan win95 spookemon`) or a Windows device name (`con prn aux nul com1-9 lpt1-9`), write your own (add `-theme`). |
| Mood or reference | Words, a brand colour, a picture | The starter palette (step 4) closest to the mood. |
| Light or dark | The mode | `dark`. |
| Base look | Which of fourteen looks gives the structure (step 2) | `midnight`. Another only when the request names a look (console, glossy, pixel, retro, terminal). |
| Single file or folder | The artifact's shape | Single file. A folder for a font, a picture over about 20 KB, or CSS that is unwieldy as one JSON string. |
| Pictures and fonts | What the requester supplies | None. Never download any; use supplied files or draw SVG and gradients yourself. |
| Where to write | Output directory | The one named; else the current one. Absolute path (5.8). |
| Installed where | Running server, or only handed over | Only handed over. Install (R10) only if given an address. |
| Author, description, version | Metadata | Author: leave out unless given (never invent a person). Description: one sentence, at most 140 characters, what it looks like. Version `1.0`. |
| Colour-blind safety | Status colours apart | Always: step 5 colours. |
| How many | One or several | One artifact and one id each; end with a summary table. |

## 3. Output contract

One artifact per theme:

```
<id>.json                a single-file theme

<id>/                    a folder theme
  theme.json             required: the manifest
  theme.css              optional: extra rules, added after the manifest's "css"
  assets/<file>          optional: pictures and fonts, one level deep
```

- UTF-8, no byte order mark, LF line endings, a final newline, two-space indent. Strict JSON: double quotes, no comments, no trailing commas, no repeated key in one object, no `null` (leave the field out).
- The manifest has `"shadowtheme": 1`, `"id"`, `"name"`, `"base"`, `"mode"`, then `"palette"`, then `"tokens"`, `"fonts"`, `"css"` if used, and — folder themes only — `"logo"` and `"icons"` (recipe 5.9). Write the id yourself; it matches `/^[a-z0-9][a-z0-9-]{0,31}$/`, is at most 32 characters, is not a built-in id and not a Windows device name. The file or folder is named exactly as the id.
- A single file may not mention `assets/`: embed a picture or font as a base64 `data:` URL, or make a folder.
- Touch no file you were not asked to make. Field rules, limits, value grammars: reference R1 to R4, if needed.

## 4. Decision procedure

Apply the steps in order. The numbers need no judgement; where a rule and your taste disagree, the rule wins and the preview is the referee.

### Step 1. Settle the facts

Complete section 2; note id, name, mode, base, form and your assumptions.

### Step 2. Choose the base look

`base` supplies the **structure**: corner rounding, typeface, flat or glossy panels and buttons, borders, shadows, glows, decorations. Your palette supplies colours, but every base also draws some things in colours of its own: pick by structure, then a palette that goes with what it hard-codes. **Default `midnight`**: flat, hard-codes nothing. `purple` is identical to it (never choose it). Every hard-coded decoration: reference R8.

| `base` | Radius / large | Panels | Draws in its own colours | Suits |
|---|---|---|---|---|
| `midnight` | 6px / 8px | flat | nothing: flat, plain | Everything. The default. |
| `purple` | 6px / 8px | flat | nothing (same as midnight) | Never: use `midnight`. |
| `oled` | 6px / 10px | flat | lilac glows on buttons, bar, chips, title | Near-black pages with lilac or purple accents. |
| `nathan` | 5px / 8px | flat | terminal-green glows (5.4) | Black terminal themes with green accents. |
| `win95` | 0px / 0px | flat | four-tone bevels, dotted focus, Windows font | Grey, beige or teal desktop looks, light or dark. |
| `ps1` | 3px / 4px | glossy | navy band, stripe, logo, pixel face, scanlines | Dark navy or blue pages. Not light pages: the scanlines show. |
| `ps1v2` | 6px / 8px | glossy | violet band, stripe, pixel face | Dark violet or navy pages. |
| `snes` | 6px / 8px | glossy | violet band, stripe, pixel face, chunky ticks | Lavender or violet pages, light or dark. |
| `dreamcast` | 14px / 18px | glossy | stripe, faint rings top right, glossy | Blue and orange looks, light or dark. |
| `wii` | 16px / 22px | glossy | stripe, title reflection, pill buttons, wave | Light, airy themes. |
| `itsmemario` | 10px / 14px | glossy | stripe, 3D title, ground strip, tree, clouds, black borders | A sky-blue look only. Avoid it otherwise. |
| `nes` | 2px / 3px | glossy | badge red, black borders with hard offset shadows, a diagonal-textured header, a black stripe, pixel font | Boxy grey console looks. Light. |
| `yoshisisland` | 12px / 16px | flat | a cream signboard header with a green grass fringe, drawn green outlines on filled buttons, a faint hand-drawn sky of clouds and egg outlines | Light, warm, storybook looks. |
| `spookemon` | 8px / 12px | flat | violet halos on the title and filled buttons, a glowing progress fill and status dots, a violet panel ring, a faint hand-drawn night of fog, a bare branch and a moon | Dark violet or ghostly night looks. |

- A light theme: `midnight`, `wii`, `win95`, `dreamcast`, `snes`, `ps1v2` or `yoshisisland`; never `ps1` (scanlines show on light) or `itsmemario` (ground and tree are drawn on any page).
- `ps1`, `ps1v2`, `snes` put a dark violet or navy band over the header whatever the palette says: use a violet or navy palette, or override it in CSS (`header { background: #446688; }`; `body::after { background: none; }` removes the `ps1` scanlines).
- Glossy bases (`ps1 ps1v2 snes dreamcast wii itsmemario`) make two-stop gradients, so the accent band is narrower (step 4).
- A terminal look: `midnight` (recipe 5.4); `nathan` only for green phosphor.

### Step 3. Choose the mode

Always write `"mode"`: `dark` when the page is dark, else `light`. Left out, the server infers it (dark when the page's luminance is below 0.4; with no background, light for `wii` and `yoshisisland`, dark for the rest). Mode decides the shadow, the dialog backdrop and which side of the mid-tones a too-grey colour moves to.

### Step 4. Choose the four seeds

`background` (page), `surface` (panels, lists, toolbar, menus), `text`, `accent` (buttons, selection, progress, links). Use `#rrggbb`. Compute WCAG luminance and contrast with the snippet in appendix A; do not guess.

**What the engine enforces, and what is only advice.** The page moves a seed only when it must (not an error: the theme passes, but no longer matches what you chose). Verified against the engine:

| Seed | Moved by the page when | Advice only (looks designed; not checked, never moved) |
|---|---|---|
| `background`, `surface` | Luminance in the mid-tone gap 0.094 to 0.315 (0.086 to 0.335 for a glossy surface): no white or black text reaches 7.3:1. A page and surface on opposite sides (dark page, light surface) are pushed apart to 11:1. | Dark page luminance at most 0.02 (lightness 4 to 12 %, saturation 25 to 60 %; 0 to 15 % if neutral). Dark surface lighter by contrast 1.10 to 1.40, same hue within 20 degrees. Light page luminance 0.60 to 0.93 (lightness 90 to 96 %, saturation at most 45 %); surface brighter by 1.05 to 1.30 (white is fine). The page/surface contrast has no limit of its own (1.54 with white passes untouched) but must not be equal: panels would lose their edge. |
| `text` | Under 7.1:1 on the page, dialog, tray or panels. | Contrast at least 10:1 with the page (dark lightness 90 to 97 %; light 8 to 20 %). The saturation cap (dark 40 %, light 45 %) and hue within 40 degrees of the page are advisory: saturated text such as amber `#ffc266` stays unmoved when the contrast holds. |
| `accent` | Luminance in the forbidden band 0.15 to 0.23 (flat) or 0.09 to 0.32 (glossy): neither white nor near-black `#0b0b12` button text reaches 5.2:1. | Dark: luminance at least 0.23 flat, 0.32 glossy (lightness 55 to 75 %, saturation 55 to 100 %). Light: at most 0.14 flat, 0.09 glossy (lightness 30 to 48 %; yellows and greens less). |

**How to know a seed moved:** the check output does not say; run `check.js --verbose` and compare `--bg`, `--text`, the first colour of `--panel` and of `--accent` with your seeds (on a glossy base the first stops are 5 and 3.5 lightness points lighter: gloss, not a move). Flat bases: `midnight purple oled nathan win95`. Glossy: `ps1 ps1v2 snes dreamcast wii itsmemario`.

`accent` also gives links, icons and the focus ring, which the page adjusts separately (4.7:1 and 3.1:1). Optional seeds: `dialog` (dialog background; for high contrast, 5.1), `tray` (bottom bar), `link` (links and title; default the accent). `surface2` is ignored: never write it. A missing seed comes from the base's own (an accent-only palette gets `midnight`'s navy page): write all four.

**Starter palettes.** Each row was run through the page's own engine: seeds unmoved on a flat base, every pair passes, good and bad apart under colour-vision simulation. Use one as is, or as the start for the mood. For a glossy base, move the accent into the glossy band and rerun.

| Name | Mode | `background` | `surface` | `text` | `accent` | Contrast page/surface, text/page, accent luminance | Note |
|---|---|---|---|---|---|---|---|
| Deep sea | dark | `#0c1b26` | `#12293a` | `#e6f4f7` | `#4fd1c5` | 1.17, 15.5, 0.51 |  |
| Ember | dark | `#1a1210` | `#281c18` | `#f7ede6` | `#ff8a4c` | 1.12, 16.0, 0.40 |  |
| Forest | dark | `#0e1a14` | `#17271e` | `#e8f3ea` | `#6fd08c` | 1.14, 15.7, 0.50 |  |
| Violet night | dark | `#15111f` | `#211b32` | `#efe9fb` | `#b18cff` | 1.12, 15.7, 0.35 |  |
| Rose | dark | `#1c1017` | `#2b1b25` | `#fbeaf1` | `#ff7aa8` | 1.13, 16.0, 0.38 |  |
| Paper | light | `#eef1f5` | `#ffffff` | `#1d2733` | `#2a5fc9` | 1.13, 13.3, 0.13 |  |
| Lavender | light | `#eeeaf8` | `#ffffff` | `#241d38` | `#5233c4` | 1.18, 13.6, 0.08 |  |
| Stone | light | `#ebebe8` | `#fafaf8` | `#222222` | `#4a4a52` | 1.14, 13.3, 0.07 |  |
| Near-black | dark | `#000000` | `#111111` | `#f2f2f2` | `#4fd1c5` | 1.11, 18.8, 0.51 | OLED black; surface 1.11 from the page |
| Black, high contrast | dark | `#000000` | `#141414` | `#ffffff` | `#ffd166` | 1.14, 21.0, 0.68 | low vision: add the edge tokens and palette.dialog (5.1) |
| Snow | light | `#f7f5f0` | `#ffffff` | `#1a1a1a` | `#2a5fc9` | 1.09, 16.0, 0.13 | very pale; surface only 1.09 from the page |
| Clear day | light | `#dce3ed` | `#ffffff` | `#0e1620` | `#1d4ba8` | 1.29, 14.1, 0.08 | low vision: add the edge tokens and palette.dialog (5.1) |
| Steel, wide gap | light | `#c9d1dc` | `#ffffff` | `#0e1620` | `#1d4ba8` | 1.54, 11.8, 0.08 | the darkest page worth using next to white (1.54) |

Status colours for all dark rows: `good #4cd7b4`, `bad #ff6b57`, `warn #ffc857`; for all light rows: `good #107171`, `bad #b0381b`, `warn #8a5c00`.

### Step 5. Choose the status colours

`good`, `bad`, `warn` colour success, error and caution text, the status dot, the status pills and Delete. They sit beside words nearly everywhere, but the connection dot is colour only. Use:

| Mode | `good` | `bad` | `warn` |
|---|---|---|---|
| dark | `#4cd7b4` (teal) | `#ff6b57` (vermilion) | `#ffc857` (amber) |
| light | `#107171` (teal) | `#b0381b` (burnt red) | `#8a5c00` (dark amber) |

The rule: `good` is teal (hue 160 to 180), `bad` vermilion (hue 5 to 15); under simulated protanopia and deuteranopia the two differ by CIE76 delta-E of at least 25 (these score 30 and 43 dark, 40 and 57 light; plain green and red 13). If the requester gives their own, keep them, score them with appendix A, and say in COMPROMISES if a pair is under 25. The page moves a status colour, keeping its hue, that lacks 4.7:1.

### Step 6. A reference picture or a brand colour

**A brand colour** becomes `accent`. If its luminance is in the forbidden band, move it out with the smallest lightness change (keep hue and saturation) and say so. With hue `H` (degrees): dark page HSL(H, 45 %, 10 %), surface HSL(H, 40 %, 15 %), text HSL(H, 25 %, 94 %); light page HSL(H, 35 %, 94 %), surface white, text HSL(H, 30 %, 14 %). A neutral brand (saturation under 10 %) gives a neutral page (saturation 0 to 8 %).

**A reference picture:** get eight colours (`magick INPUT -resize 64x64 -colors 8 -unique-colors txt:-`, or Pillow `quantize(8)`, or by eye, and say so). Most frequent dark colour = page; a lighter cluster of the same hue = surface; the lightest low-saturation cluster = text; the most saturated mid-tone = accent. Push each into its band by changing lightness only. Never embed or trace the picture.

### Step 7. Token overrides: rarely

`tokens` overrides derived variables after derivation. Change the palette instead whenever you can: the page does not re-derive from an override, so dependants stay tuned to the old value.

- **Safe, any time** (in no readability pair): `--meta` `--bg-image` `--line` `--panel-shadow` `--check` `--ghost-line` `--danger-line` `--input-line` `--tray-line` `--backdrop` `--warn-line` `--radius` `--radius-lg` `--font`. (`--bg-image` is in no pair, but a picture can still hurt legibility: step 8.)
- **Safe: edges and shadows** for separation (recipe 5.1): `--line`, `--ghost-line`, `--input-line`, `--panel-shadow`.
- **Safe: raising a quiet text colour** on its own background (`--sel-muted`, `--panel-muted`, `--muted`). The derived `--sel-muted` already reaches 4.7:1 (5.2); override it only for a stronger look.
- **Paired**: override a background token (`--panel`, `--bg`, `--sel`, `--accent`, `--dlg-bg`, `--input-bg`, `--warn-bg`, `--tray`...) only with every text token readable on it, or the report fails. The full table of which text goes on which background is reference R3.
- **Never** override to fix a failure the palette causes (wrong seed), and never give a text token an alpha (the report treats it as solid).

### Step 8. Single file or folder; pictures and fonts

- **Single file**: no pictures, or under about 20 KB embedded as `url(data:image/svg+xml;base64,...)` (only `data:image/(png|jpeg|webp|gif|svg+xml);base64,` is accepted; base64 is a third bigger: `node -e "process.stdout.write(require('fs').readFileSync('a.svg').toString('base64'))"`). A picture is at most 300 KB decoded, a font 900 KB, the file 1 MiB.
- **Folder**: a font, a picture over about 20 KB, or a hand-written SVG file, in `assets/`, referred to as `assets/<file>`. The page's "Try it" cannot show `assets/` pictures (they exist once installed): use `preview.js`.
- **A header logo and a custom icon set** are `assets/<file>` pictures too, set with the `logo` and `icons` manifest keys (recipe 5.9), not with `--bg-image`.
- A picture behind the page (`--bg-image`) must be quiet: recipe 5.7. The text on top is measured only against flat colours, so a busy picture can pass `check.js`; the preview measures real pixels.
- Fonts: declare a file only when the requester supplies one they may redistribute (`"fonts"`: `family`, `src`, `weight`; then the family in `--font`). Installed fonts need no entry (5.6). The pixel font of `ps1 ps1v2 snes` stays on buttons, title and dialog headings whatever `--font` says.
- SVG by hand: plain shapes (`path rect circle line polygon g`) with `xmlns`, `width`, `height`, `viewBox`. Refused: `<script>`, `foreignObject`, `iframe`, `embed`, `object`, `on...=`, `@import`, `javascript:`, entities, an `href`/`src` to anything but `data:image/`.

### Step 9. CSS: when, and how

Only for what tokens cannot reach: letter-spacing, an outline, a bar on the selected row, removing a base decoration, squaring the pills (5.5). A handful of rules.

- A theme is meant to restyle the page, not hide it or change its words. The checker refuses the common ways to hide or blank the page (a denylist) but cannot catch every one, so do not try to; never write css that hides, fades or covers the page. Refused in every rule: `content` other than `""`, `none` or `normal`; `display: none` (and `display: contents` on `html`, `body` or `*`); `visibility: hidden` or `collapse`; `opacity` below 0.3 (also inside `filter: opacity()`); text under 8px (`em`, `rem` and `%` are measured against 14px); `scale` under 0.3; and `var()` in any of these properties. If a theme ever makes the page unusable, open the page with `?safe=1` at the end of its address (safe mode ignores custom themes for that visit) and remove the theme.
- Plain rules only: `selector { property: value; }`. No at-rules (`@media`, `@keyframes`, `@font-face`, `@import`), no nesting, no backslash, no colon or semicolon in a value outside a quoted string (R5).
- The server prefixes every selector with `html[data-custom="<id>"]`, so rules apply only to your theme. Your rules beat the base's plain rules but not a base rule built from a chain of `:not()` (the console looks' buttons; `nathan`'s button glow): add `!important` (allowed) there.
- Hooks: `header`, `h1`, `svg.logo`, `.panel`, `.row`, `.row.sel`, `.row.head`, `.toolbar`, `.tray`, `dialog`, `button`, `button.ghost`, `button.danger`, `.chip`, `.chk.filter-chip`, `.dl` (Activity or History entry), `.dl .tag` (`.done .failed .stalled .downloading .stopped .struggling`), `.pbar i`, `nav.crumbs`, `footer.credits`, `body`.
- Do not restyle layout (`display`, `position`, `width`, `flex`): the page must work at 375 px. Colours set in CSS are not in the readability report; look at those screens.

### Step 10. Write, check, preview, iterate

Write the files (section 3), then loop through section 6 until section 7's definition of done holds.

## 5. Recipes

### 5.1 High contrast, low vision

Separation between page, panels, dialogs and fields does not come from the palette; it comes from these, all safe overrides:

- `--line` (edges of panels, toolbar, dialogs, row rules, chips), `--ghost-line` (outline buttons), `--input-line` (fields), `--panel-shadow`, and the optional palette seed `dialog` (the dialog background derives 12 % toward white or black from the page: almost the page colour, and equal to it on a black page, so dialogs blend in until you set it).
- **Minimum: every edge at least 3:1 against both things it separates** (WCAG 2.2 non-text contrast, 1.4.11): the page, the surface (`--panel`), the dialog (`--dlg-bg`) and the input background (`--input-bg`); read those four from `check.js --verbose`. Formula, checked on every starter in both modes: `--line` = 60 % text seed + 40 % page seed per channel (at least 3.9:1); `--ghost-line` and `--input-line` = 80 % text + 20 % page.
- `--panel-shadow`: light page `0 2px 6px rgba(0, 0, 0, 0.25)`; dark page, where a shadow is invisible, a ring in the `--line` colour: `0 0 0 1px #999999`.
- The page/surface gap is free (step 4). **Practical limit next to a white surface: page luminance 0.60** (for example `#c9d1dc`, contrast 1.54 with white; near-black text still has 11:1). Darker, and text cannot keep 10:1 on the page; below 0.315 the page is moved. The band 1.05 to 1.30 is advice, not a limit.
- Dark example, starter "Black, high contrast": `"dialog": "#1c1c1c"` in the palette; tokens `"--line": "#999999"`, `"--ghost-line": "#cccccc"`, `"--input-line": "#cccccc"`, `"--panel-shadow": "0 0 0 1px #999999"`, `"--sel-muted": "#efeeea"`. The light one (starter "Clear day") is complete in reference R13.2. 

### 5.2 `--sel-muted` (quiet text on the selected row)

`--sel-muted` colours the small grey text on a selected row (file name line, version and kind chips). The page derives it at 4.7:1 (never under 4.5:1), the same as the preview's small-text line, so on every starter with saturated accents in both modes it passes without an override. Add one only for a stronger look (5.1): `"tokens": { "--sel-muted": "<90 % of your text seed + 10 % of --sel, per channel>" }`, or simply your `text` seed. Read `--sel` (its first colour) from `check.js --verbose`. It is a foreground-only override on a token nothing else derives from, so it cannot break another pair, but it must stay at 4.5:1 or more on `--sel`.

### 5.3 Near-black and other extreme pages

Starter rows exist for `Near-black`, `Black, high contrast`, `Snow` (very pale) and `Steel, wide gap`. A page of luminance 0 to 0.02 is fine, and a surface contrast of 1.07 to 1.11 comes out unmoved, but a gap under 1.10 makes panels hard to see: widen it, or add `--line` or a shadow (5.1). To darken a starter, lower page and surface lightness together and keep the gap.

### 5.4 Terminal looks: `midnight` or `nathan`

- **`midnight` (choose this by default, and always for a colour other than green):** flat, no glows. Tokens `--radius` and `--radius-lg` `0`, a monospace `--font` (5.6), and three rules in `css`: `.chk.filter-chip, .chip, .dl .tag, .pbar, .pbar i { border-radius: 0; }` (the pills ignore `--radius`, 5.5), `h1 { text-shadow: 0 0 8px rgba(255, 176, 0, 0.5); }` (your own glow), `.row.sel { box-shadow: inset 3px 0 0 #ffb000; }`.  This is the tested amber theme (reference R13.1).
- **`nathan`:** the same structure plus glows in terminal green `#33ff66`, hard-coded in page rules (`h1`, `button:not(.ghost):not(.danger):not(.theme-opt)`, `button.ghost:hover`, `.pbar i`, `.row.sel`, `.chip`, `.chip.ok`, `.dot.ok`, `.dot.bad`); none follows your palette. With a green palette they are free: choose `nathan`. With another colour they clash; remove them with `h1, button, .chip, .row.sel, .pbar i, .dot { box-shadow: none !important; text-shadow: none !important; }` (`!important`: a `:not()` chain outranks your selector). Choose `nathan` only when its look is wanted.

### 5.5 Corners: what ignores `--radius`

`--radius` (buttons, fields, selects, banners) and `--radius-lg` (panels, toolbar, dialogs, menus, picker rows) are tokens. These keep their own rounding: `.chk.filter-chip` (the toolbar filter chips "Needs attention", "Homebrew", "Duplicates" and the "Game + newest update" pill: 999px), `.dl .tag` (status pills: 99px), `.pbar` and `.pbar i` (progress bars: 99px), `.chip` (the small game / version / PS5 chips: 3px), `.dot` (round), `.row-cover` (6px). Only `win95` squares its filter chips itself. For a square theme add the one rule `.chk.filter-chip, .chip, .dl .tag, .pbar, .pbar i { border-radius: 0; }`; it wins over every base.

### 5.6 Fonts

A stack in `--font` needs no `fonts` entry; only supplied font files do. Write up to 8 families, at most 200 characters, and always end with a generic family (`sans-serif`, `serif`, `monospace`, `system-ui`), because a name that is not installed is skipped. Names with spaces may be quoted or bare. Fonts on ordinary machines:

- Windows: Segoe UI, Calibri, Cambria, Tahoma; monospace Cascadia Mono, Consolas.
- macOS: Helvetica Neue, Avenir Next, Palatino, Optima; monospace Menlo, Monaco.
- Linux: DejaVu Sans / Serif / Sans Mono, Liberation Sans / Serif / Mono, Noto Sans.
- On all three: Arial, Georgia, Verdana, Trebuchet MS, Times New Roman, Courier New.

Stacks: sans `"Segoe UI", "Helvetica Neue", Arial, sans-serif`; serif `Georgia, Palatino, "Times New Roman", serif`; monospace `"Cascadia Mono", Consolas, Menlo, "DejaVu Sans Mono", "Courier New", monospace`.

### 5.7 SVG background patterns

`--bg-image` is `url(data:image/svg+xml;base64,...)` in a single file or `url(assets/tile.svg)` in a folder, optionally over a gradient (up to 3 layers, the first on top). Keep it quiet:

- Shapes at 5 to 12 % opacity of one saturated colour on a dark page (12 % is the most before text suffers), 8 to 15 % of a dark colour on a light page.
- A tile of 160 to 320 px, plain `path` / `circle` / `line` shapes, 3 to 8 of different sizes placed off the grid, under about 4 KB. To hide the repeat, use two tile layers of unrelated sizes (for example 240 and 310 px).

### 5.8 Paths and shells

The theme and `--out` may be anywhere; on Windows use absolute paths with forward slashes (`C:/Users/me/themes/x.json` works in Git Bash, PowerShell and cmd). Git Bash maps `C:Users...` to `/c/Users/...`; `/c/...` and `/tmp/...` mean nothing to PowerShell or cmd. When you pipe (`| tail`, `| grep`) the shell reports the last command's exit code: the last line `exit N: ...` of `check.js` and the `VERDICT:` line of `preview.js` are authoritative (or `set -o pipefail`).

### 5.9 Header logo and custom icon set (folder themes)

Two additive, opt-in manifest keys for a folder theme; a single-file theme cannot set them (they reference `assets/`). Leave both out and the theme behaves exactly as before.

- `"logo": "assets/<file>"` — one picture shown in the header in place of the built-in glyph; the h1 wordmark text is hidden (the logo *is* the title). Drawn at a capped height (default 32 px, width auto).
- `"icons": { "<kind>": "assets/<file>", … }` — overrides the built-in row icon per kind. Kinds not given fall back to the built-in icon. The kinds are `file`, `document`, `text`, `image`, `video`, `audio`, `archive`, `disk`, `code`, `package`, `folder` (the `FILE_ICONS` map); an unknown kind is ignored with a warning.

Rules and limits:

- The value must be `assets/<file>` and the file must exist in the theme's `assets/`. Any picture type a theme can hold is accepted: `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.svg`. An SVG is scanned by the same rule as a `--bg-image` asset — plain vector shapes only, no script and no outside link.
- They render **full colour, as-is** — not tinted by `--icon`/`currentColor`. That is the point (a coloured egg, not a monochrome glyph), so a busy or low-contrast icon is on you: look at it in the preview.
- The logo and the icons are in no readability pair, so `check.js` does not measure them. Verify by eye in `preview.js`: the logo and the row icons show on `01-main.png` (and `02-selected.png` for a folder icon).

## 6. Validation loop

Run from the ShadowPKG repository root (the folder that holds `server.js`); Node 18 or newer for `check.js`, Node 22 or newer for `preview.js`. If `tools/themes/` is missing (an older checkout), use the raw call in reference R10 and say so.

### 6.1 Check

```
node tools/themes/check.js <theme file or folder> [--json] [--allow-low-contrast] [--verbose] [--server <url>] [--port <n>]
```

`<theme>` is `<id>.json`, the folder `<id>/`, or its `theme.json`. It starts this checkout's `server.js` on a free local port with a temporary config folder and stops it; nothing leaves the machine. The line `checked by: a scratch server.js on 127.0.0.1:<port>` names the port. `--port <n>` chooses it (default: a free one from 13600 to 13619, else any; a taken port gives `NOT CHECKED`; not with `--server`). `--verbose` prints every resolved token. `--json` prints `{ok, problems, warnings, theme, report, exit}`. `--server <url>` asks a running server.

| Exit | Meaning | What to do |
|---|---|---|
| 0 | Accepted, every readability pair passes. Last line `exit 0: valid, and every readability pair passes`. | Go on to the preview. |
| 1 | Refused (`REJECTED` or `NOT CHECKED`, with problems), or a palette-derived pair fails (`engine bug`). | Fix the first problem (R11), run again. An engine bug is not yours: change the palette until it passes and say so. |
| 2 | Accepted, but an override in `tokens` leaves a pair below its minimum (the row says FAIL and `override (--token)`). | Fix or delete the override. `--allow-low-contrast` only if the requester wants it low, and say so. |

**Iterate until it exits 0 and no row says FAIL.** A warning is not a failure but read it (an alpha that flatters a ratio, or CSS that sets a token: not in the report).

Reading the output: `ACCEPTED: <name>` and a facts block; `warnings:`; then the table of every readability pair, 47 for a `midnight`-based theme and 46 for `wii` (shortened here): the worst ratio over every colour the text sits on, its minimum, PASS or FAIL, `derived` or `override (...)`; each failure again after the table; the last line is the verdict and exit code. A failing theme (`--panel-muted` overridden too dark, `--sel-muted` with an alpha, a token set in css):

```
$ node tools/themes/check.js low-override.json
(the facts block and the warnings are left out)
readability: 47 pairs, 5 below their minimum
  pair                                  ratio  min  result  from
  Muted text on panels                   1.89  4.5  FAIL    override (--panel-muted)
  Selected row, muted text               6.41  4.5  PASS    override (--sel-muted)
  Muted text on a list header            1.56  4.5  FAIL    override (--panel-muted)
  Muted text on a hovered row            1.65  4.5  FAIL    override (--panel-muted)
  Muted text on outline buttons          2.21  4.5  FAIL    override (--panel-muted)
  Stopped tag                            1.47  4.5  FAIL    override (--panel-muted)
  FAIL Muted text on panels: --panel-muted #3a5468 on --panel #12293a is 1.89:1, needs 4.5
  FAIL Muted text on a list header: --panel-muted #3a5468 on --panel-head #213747 is 1.56:1, needs 4.5
  FAIL Muted text on a hovered row: --panel-muted #3a5468 on --hover #1d3343 is 1.65:1, needs 4.5
  FAIL Muted text on outline buttons: --panel-muted #3a5468 on --ghost-bg transparent is 2.21:1, needs 4.5
  FAIL Stopped tag: --panel-muted #3a5468 on --panel #12293a is 1.47:1, needs 4.5

exit 2: valid, but explicit overrides leave 5 pairs below the minimum (--allow-low-contrast accepts this)
(41 more rows, all PASS and derived, are left out of this listing)
```

Delete the override or choose a value that reaches the minimum on every background named in the FAIL lines, then run again.

### 6.2 Preview

```
node tools/themes/preview.js <theme file or folder> --out <folder> --phone [--only main,selected,history] [--builtin <id>] [--browser <path>] [--port <n>] [--debug-port <n>]
```

It starts a scratch server with made-up packages and history, installs the theme through the real API, opens the page in headless Chrome, Edge or Chromium (it finds one; `--browser` names one), and writes PNGs into `--out`: desktop 1000x800 and, with `--phone`, every screen again at 375x760 with `-phone` in the name (about 50 PNGs, about a minute; `--only` cuts it for a quick pass). **Always pass `--phone`.** `--port` and `--debug-port` choose the scratch server's port and the browser's debugging port (default: free ones); the line `Ports used: ...` near the top names both. `--only` takes `main selected dump history activity themes setup maker install`; `--builtin <id>` previews a built-in look with no theme, a baseline.

**Read the end of the output first** (pipe it through `tail -25` if you like): after the PNG list it prints

```
FINDINGS
Text below its contrast ratio (4.5:1, or 3:1 for large text): N places
[page-own]  2.91:1 (needs 4.5)  #76592e on #171007  <selector>  "hidden"  [faded to 0.6 opacity]  in 01-main-2.png
[NEW]  4.33:1 (needs 4.5)  #a8d0c8 on #186158  <selector>  "..."  in 02-selected.png  -> raise --sel-muted ...
VERDICT: only page-own findings (3 page-own): none comes from this theme, nothing to fix. ...  (or: N NEW findings ...)
```

Text is measured on the pixels actually drawn (3:1 when large). Exit code: 0 all text passes; 1 some text is below its ratio; 2 could not run or take every view (no browser, bad theme). A theme rarely exits 0, because the page itself produces findings: **judge by the VERDICT, not the exit code.** The VERDICT compares each finding with the list in `preview.js` (`PAGE_OWN`, `BASE_LOOK`): `[page-own]` (any theme shows it) and `[base-look]` (a colour the base hard-codes, which the built-in look of that base shows too) need no fix; `[NEW]` is caused by your theme (a token override, css that sets its own colour, the base or a picture behind text) and must be fixed or explained. If it cannot run (no browser), say so in PREVIEW and rely on `check.js`.

**Findings the page itself produces**, measured on all fourteen built-in looks and on custom themes:

- **`[page-own]`, every theme shows these** (the page fades them itself, or draws quiet text on a tinted page): the "hidden" chip on a dimmed row; the name of a dimmed (hidden) row; the footer credits and their links; the Details button in the warning banner; the detail text of a warning in Setup; the "Hide for a day" button in Setup; the "zip archive" chip; the "Install from a URL instead" line.
- **`[base-look]`, only on these bases** (colours the base hard-codes; the built-in look of that base shows them too): on `ps1 ps1v2 dreamcast itsmemario`: the build-options summary on the dump card, the tick of a good check in Setup; on `ps1 dreamcast itsmemario`: the Delete button in the tray; on `dreamcast itsmemario win95`: the breadcrumb and its Up button; on `ps1v2 snes`: a header or dialog button drawn by the pixel-face looks; on `snes`: the tick in the Themes picker.

When in doubt compare with `node tools/themes/preview.js --builtin midnight --only main --out <folder>`. A finding on a selected row (`.row.sel`: the file name line, the version and kind chips) is `[NEW]` with a hint: it is the `--sel-muted` case (5.2).

**Files.** Open first: `01-main.png`, `02-selected.png`, `04-history.png`, then the same three with `-phone`. A long view continues in `-2`, `-3`. Open `03-dump`, `05-activity`, `06-themes`, `07-setup`, `08-maker`, `09-install` only when you changed dialog or status colours or the base (what each shows: reference R9).

**Visual checklist** (answer each by looking):

1. Text legible everywhere (quiet text, links, footer, chips, button labels); the selected row clearly differs from the others, with legible text and visible ticks.
2. Main buttons (fill), outline buttons, Delete and the dimmed Info button are distinguishable from the page; panels have an edge (toolbar, list, dialogs, tray); progress bars show against their track.
3. In `04-history` the Downloaded, Failed, Incomplete and Built pills differ by colour and by word.
4. A background picture does not fight the text and looks like what you drew.
5. Focus ring: not in a screenshot; read the two "Focus ring" rows of the check (at least 3:1).
6. Phone width: nothing cut off at the right edge, header and tray wrap, dialogs fit. Clipping that belongs to the page: the toolbar chip row scrolls sideways, the Downloading line is clipped on the left in every theme, and the pixel font of `ps1 ps1v2 snes` clips long status lines. Unsure: `--builtin <your base> --phone --only main` and compare.
7. It still reads as what was asked.

## 7. Done and common errors

### 7.1 Definition of done

- [ ] One artifact per theme, named `<id>.json` or `<id>/`, in the directory the requester named; UTF-8, no BOM, LF, strict JSON, final newline, no repeated key, no `null`.
- [ ] Manifest has `shadowtheme`, `id`, `name`, `base`, `mode` and a palette of all four seeds plus the three status colours; the id is not a built-in and matches the file or folder name.
- [ ] A single file has no `assets/`; a folder's `assets/` files are all used and are what their names say.
- [ ] Seeds follow step 4 (or you say which the page moved); status colours are step 5's; every override has a reason.
- [ ] `check.js` exits 0 (or 2 with every failing pair explained and the requester's consent).
- [ ] `preview.js --phone` ran; you looked at the main, selected, history and phone images and 6.2's checklist holds; the VERDICT shows no `[NEW]` finding, or each is explained.
- [ ] You wrote nothing outside the theme files, edited no app code, ran no git; scratch files are removed.
- [ ] The final message has the shape at the top.

### 7.2 The errors you are most likely to meet

| You see | Cause and fix |
|---|---|
| `... is not valid JSON: ...` | A comma, quote, comment or bracket; `check.js` prints the position. |
| `... has no "shadowtheme": 1 in it` | Add `"shadowtheme": 1`. |
| A colour is refused (`red`, `black`, `var(--x)`, `currentColor`) | Write `#rrggbb`. Palette colours are opaque (`#rrggbb`); alpha is for tokens only. |
| A length, gradient or shadow is refused | Lengths need a unit (`10px`), angles `deg`, shadows a colour; at most 6 stops, 3 image layers, 4 shadows. |
| The id is refused | Lower-case letters, digits, dashes; at most 32; not a built-in id or Windows device name. |
| `assets/...` in a single file, or an `http(s)://` url | Embed a base64 `data:` URL or make a folder; nothing loads from the network. |
| css refused (`@media`, `@font-face`, backslash, colon in a value) | Plain rules only (step 9); reference R5. |
| `exit 2` with a FAIL row | An override leaves a pair low: fix or delete the override. |
| `engine bug: N pair(s) ...` | Not yours: change the palette until it passes. |
| The preview shows `[NEW]` | An override, your css, the base or a picture: fix it (6.2). |
| The theme looks nothing like the request | Seeds at mid-tone lightness (40 to 60 %) are moved; a `dark` page with `"mode": "light"` or the reverse; `!important` on a derived colour also hides it from the report. |

Every validator message and its fix: reference R11. Never edit the app, never pass `--allow-low-contrast` to turn red green, never fetch pictures, fonts or colours from the internet, never report success without the check's exit code and the preview folder.

## 8. Worked example

**Request:** "A dark blue-green theme called Deep Sea, easy on the eyes at night." Two more examples (a light theme on the `snes` base, and a folder theme with a hand-drawn SVG and CSS) are in reference R13, with a tested terminal theme.

1. Facts: name Deep Sea; id `deep-sea`; dark; single file; no pictures; no author given (the description carries the mood). Base `midnight`: no look was named.
2. Mode `dark`. Page `#0c1b26`, HSL(205, 52 %, 10 %), luminance 0.010 (advice: at most 0.02). Surface `#12293a`, lightness 15 %, contrast 1.17. Text `#e6f4f7`, hue 191, lightness 94 %, 15.5:1 (at least 10). Accent `#4fd1c5`, a teal of luminance 0.513 (at least 0.23 on a flat base).
3. Status colours from the step 5 dark row. One override group, shape tokens (in no pair, so safe): `--radius` 10px and `--radius-lg` 14px for a softer look. No CSS, no pictures.

`deep-sea.json`:

```json
{
  "shadowtheme": 1,
  "id": "deep-sea",
  "name": "Deep Sea",
  "author": "ShadowPKG agent guide",
  "description": "Dark blue-green theme for night use: teal accent, status colours that stay apart for colour-blind viewers.",
  "version": "1.0",
  "base": "midnight",
  "mode": "dark",
  "palette": {
    "background": "#0c1b26",
    "surface": "#12293a",
    "text": "#e6f4f7",
    "accent": "#4fd1c5",
    "good": "#4cd7b4",
    "bad": "#ff6b57",
    "warn": "#ffc857"
  },
  "tokens": {
    "--radius": "10px",
    "--radius-lg": "14px"
  }
}
```

Check (shortened; the tool prints the facts block and every row, 47 here):

```
$ node tools/themes/check.js deep-sea.json
(the facts block is left out)
readability: 47 pairs, all at or above their minimum
  pair                                  ratio  min  result  from
  Muted text on a list header            5.01  4.5  PASS    derived
  Failed tag                             4.72  4.5  PASS    derived
  Stopped tag                            4.73  4.5  PASS    derived

exit 0: valid, and every readability pair passes
(44 more rows, all PASS and derived, are left out of this listing)
```

The preview showed a teal accent on a dark blue-green page and a phone layout with nothing cut off beyond what the built-ins also cut. Findings: the page's own (footer credits, the `hidden` chip) and no NEW finding on the selected row: the derived `--sel-muted` is 4.69:1 (this example leaves it out to stay a palette and two shape tokens).

## Appendix A. Colour maths snippet

Save as `colours.js` in the temp folder: WCAG luminance and contrast, mixing, and a score for two colours under protanopia, deuteranopia and tritanopia (Machado 2009, CIE76 delta-E). `node colours.js "#0c1b26" "#e6f4f7"` prints the contrast; `node colours.js "#4cd7b4" "#ff6b57" cvd` the delta-E under each; `node colours.js mix "#dce3ed" "#0e1620" 0.6` mixes (0.6 = 60 % of the second colour: the `--line` formula in 5.1); `hsl(h, s, l)` returns `#rrggbb`.

```js
// colours.js: WCAG contrast, mixing, HSL to hex, colour-vision delta-E. Usage: node colours.js "#0c1b26" "#e6f4f7" [cvd]   |   node colours.js mix "#dce3ed" "#0e1620" 0.6
const rgb = h => { h = h.replace('#', ''); if (h.length === 3) h = h.replace(/./g, '$&$&'); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const lum = h => { const [r, g, b] = rgb(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const mix = (a, b, t) => '#' + rgb(a).map((v, i) => Math.round(v * (1 - t) + rgb(b)[i] * t).toString(16).padStart(2, '0')).join('');
const hsl = (h, s, l) => { s /= 100; l /= 100; const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l), f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); return '#' + [f(0), f(8), f(4)].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join(''); };
const M = { protan: [[.152286, 1.052583, -.204868], [.114503, .786281, .099216], [-.003882, -.048116, 1.051998]], deutan: [[.367322, .860646, -.227968], [.280085, .672501, .047413], [-.01182, .04294, .968881]], tritan: [[1.255528, -.076749, -.178779], [-.078411, .930809, .147602], [.004733, .691367, .3039]] };
const enc = v => 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055);
const sim = (h, k) => { const l = rgb(h).map(lin); return M[k].map(r => enc(Math.min(1, Math.max(0, r[0] * l[0] + r[1] * l[1] + r[2] * l[2])))); };
const lab = c => { const [r, g, b] = c.map(lin), f = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116); const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047), y = f(0.2126 * r + 0.7152 * g + 0.0722 * b), z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883); return [116 * y - 16, 500 * (x - y), 200 * (y - z)]; };
const dE = (a, b) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]));
module.exports = { lum, contrast, mix, hsl, deltaE: (a, b, k) => dE(sim(a, k), sim(b, k)) };
if (require.main === module) {
  const [a, b, mode, t] = process.argv.slice(2);
  if (a === 'mix') console.log(mix(b, mode, Number(t)));
  else if (mode === 'cvd') for (const k of Object.keys(M)) console.log(k, dE(sim(a, k), sim(b, k)).toFixed(1));
  else console.log('luminance', lum(a).toFixed(4), b ? lum(b).toFixed(4) : '', b ? '| contrast ' + contrast(a, b).toFixed(2) : '');
}
```
