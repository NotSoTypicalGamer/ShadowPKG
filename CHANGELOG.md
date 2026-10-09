# Changelog

Notable changes to ShadowPKG, newest first.

## [1.0.0] - Unreleased

First stable release.

### Highlights

- Browse and search PKG libraries, gathering each game with its updates and DLC, with rename, delete, duplicates, history, game-dump builds, DLC region unlocker, install-from-URL, and cover art.
- Send to consoles over DPI v2 (Elf Arsenal / etaHEN) and PS4 Remote Package Installer — multi-console, queued, with live progress and stalled-transfer detection.
- Serve packages (and packages still inside `.rar` archives) over HTTP with range support.
- Fifteen built-in themes plus a theme maker and custom theme files, all held to a text-readability standard.
- FTP-connected consoles (browse, upload, download), move/copy with verification, send-a-payload, and ps5-tailscale.

### This release

- Fix built-in theme readability: 40 colour adjustments across nine base themes so status text, tags, button text and muted text meet the 4.5:1 minimum (focus rings and decorative icons are non-text and left as designed).
- Rework the readability guard (`tools/themes/check-bases.js`) to check the same standard the runtime applies to custom themes, and clear it for all fifteen bases.
- Add CI (`.github/workflows/ci.yml`): syntax check, readability guard, and a boot smoke test on every push and pull request.
- Add a smoke test (`test/smoke.js`) that boots the server on a throwaway port and fetches the page.
- Finish the `itsmemario` theme (drop the "WIP" tag).
