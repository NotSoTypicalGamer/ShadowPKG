# Theme extensions: custom logo and icon set

Two additive capabilities for the theme format (format 1, `"shadowtheme": 1`) so a theme can
restyle more than colour and shape: a **header logo** and a **custom icon set**. Both are
opt-in and backward-compatible — a theme without them behaves exactly as before.

Motivation: a full "Yoshi's Island"-style skin wants a sprite + wordmark in the header and egg
icons in the list. Colour tokens alone cannot express those; they need theme-supplied SVG.

## Manifest

Two new top-level keys (folder themes only — they reference `assets/`):

```json
{
  "logo": "assets/logo.svg",
  "icons": {
    "folder": "assets/folder.svg",
    "package": "assets/package.svg",
    "file": "assets/file.svg"
  }
}
```

- `logo` — one `assets/<file>` path. The SVG is shown in the header in place of the built-in
  glyph; the wordmark text is hidden (the logo *is* the title). Sizing is height-based and
  capped (see below).
- `icons` — an object keyed by icon kind → `assets/<file>` path. Kinds not provided fall back
  to the built-in icon. The known kinds are the `FILE_ICONS` map: `file`, `document`, `text`,
  `image`, `video`, `audio`, `archive`, `disk`, `code`, `package`, `folder`.

## Validation and safety

- Both fields reuse the existing SVG scanner (`themeSvgProblem`): plain vector shapes only, no
  `script`/`foreignObject`/`iframe`/`embed`/`object`, no external `href`/`src`, no `on…=`,
  no `@import`. A logo is held to the same standard as a `--bg-image` asset.
- The ref must be `assets/<file>` and the file must exist in the theme's `assets/` (a single-file
  theme has no `assets/` and so cannot set either field).
- Icon/logo SVGs render **as-is (full colour)** — they are not tinted by `--icon`/`currentColor`,
  because the whole point is a coloured egg, not a monochrome glyph.

## Rendering

- **Logo:** on theme apply, the SVG is injected into the existing `.logo` element (which today is
  `display:none` except on the `ps1`/`ps1v2`/`snes` bases), the element is shown, and the h1
  wordmark (`<span>` of `.lt` letters) is hidden. No theme: the built-in glyph and text return.
  The logo is served at `themes/<id>/assets/logo.svg` and drawn at a capped height (default 32px,
  width auto) so a wide wordmark does not blow the layout.
- **Icons:** the row renderer (`typeIcon`) and the directory icon (`ICON_DIR`) consult a
  theme-overlay of `FILE_ICONS`. A kind the theme provides is emitted as an `<img
  src="themes/<id>/assets/<file>.svg">` (full colour); otherwise the built-in `currentColor` SVG
  is emitted as today.

## Code touch points

- `server.js`
  - `THEME_KEYS` — add `logo`, `icons`.
  - theme manifest validation — parse/validate both fields (asset ref + existing file).
  - cleaned manifest — carry `logo`/`icons` through.
  - `THEME_SUMMARY` — add both, so the list and `GET /api/themes/<id>` carry them to the page.
- `index.html`
  - `normTheme` / `paintOf` — carry `logo`/`icons` onto the painted theme.
  - `showNow` (or `land`) — inject/hide the logo and set the icon overlay when the theme lands.
  - `typeIcon` and the `ICON_DIR` usages — consult the overlay.

## Open decisions

- Logo height cap (fixed 32px vs a `--logo-h` token).
- Whether `document`/`code`/`disk`/etc. need theming at all, or just the visible few
  (`folder`, `package`, `archive`, `file`).
