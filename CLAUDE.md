# not-enough-tokens

Incremental Claude Code usage tracker. It reads transcript JSONL files (`~/.claude/projects/**`) on this machine and on remote machines over SSH. It aggregates token counts and their list-price cost, and shows them in a web console. The same console is meant to be packaged with Electron.

## Run

```bash
node src/cli.js serve          # prints the console URL with its access token
node src/cli.js sync [id...]   # sync machines from the CLI
npm run app                    # Electron (after npm install && npx install-electron)
npm run dist:mac               # dist/*.dmg (bundles Electron, unsigned)
sh packaging/linux/install.sh  # Linux: uses the system electron, nothing bundled
```

There are no runtime dependencies; Node ≥ 20 is enough. For development, use `serve` with the built-in browser: open the printed `?token=` URL once, and a cookie keeps the session afterwards. Data lives in `~/.local/share/not-enough-tokens` (or `$XDG_DATA_HOME`). Set `NET_DATA_DIR` to point at a scratch directory when testing.

## Layout

- `src/core/`: storage and pricing.
  - Per-machine data: `ledger.js` holds hourly/daily CSV buckets, the `seen.json` dedupe map and `cursors.json`.
  - `sync.js` does the incremental read. `sync-worker.js` runs each sync in a child process so its memory is released afterwards.
  - Other modules: `pricing.js` (LiteLLM table plus manual prices), `projects.js` (cwd → git repo), `settings.js`.
- `src/sources/`: where transcripts come from.
  - `local.js` reads this machine.
  - `ssh.js` reads remotes through the system `ssh`, with an askpass callback to the console. `remote_reader.py` runs on the remote side.
- `src/server.js`: HTTP API, SSE events and the askpass endpoint.
- `electron/main.js`: starts the same server in-process on a random port and opens a sandboxed window. Other origins open in the system browser.
- `packaging/linux/`: launcher, `.desktop`, `install.sh` and PKGBUILD for running on the system Electron.
- `web/`: no-build ES modules: `app.js` (main view), `settings.js`, `core.js`, `i18n.js`, `style.css`.

## Invariants

- **Reads are incremental.** A per-file byte cursor means only the appended bytes are read. A rewritten or truncated file is re-read, and the dedupe map makes that harmless.
- **Dedupe by `message.id` with max-merge.** Streamed lines repeat the same id with growing counts, and forks copy lines into other files.
- **Cost is frozen at ingest time** using the price current then. Tokens of models without a price go to the `u_*` columns until they are priced manually.
- **Bucket granularity:** hourly for the last 35 days, daily after that (`compact()`). Period math (timezone, week/month start) happens client-side.
- **No auth bypass.** The server binds to loopback, and every request needs the token. The token lives in `server-token`, is passed once as `?token=` and then kept in an HttpOnly, SameSite=Strict cookie. There is also a Host check and a custom header on writes. Don't add a way to turn this off.
- **Remote machines are read-only.** Use only find/stat/tail/grep/python, and never write there.
- **macOS automount paths:** never touch `/home`, `/net`, `/Network` or `/Volumes`. Probing them triggers a network-volume privacy prompt.
- **Testing:** a full re-read is ~3 GB. Test on small inputs or a copy, and don't loop full syncs.

## UI rules

- **Rounded corners must be curvature-continuous (G2), never a circular arc.** This rule is about how rounded corners are drawn. It does not ban sharp features: ridges, glyph strokes, chevrons and other deliberate points are fine.
  - In CSS, use `corner-shape: squircle` with the `--r-*` radius tokens. Never use raw `border-radius` values.
  - In SVG, draw rounded corners with cubic Béziers whose handles keep zero curvature at the joins, not with `Q` or arc commands.
  - Apply this wherever a new component, icon or chart mark has rounded corners.
- Colors and fonts follow Anthropic's public brand guidelines.
  - Use the warm neutrals and the accent, which is shifted from the brand orange toward copper to match the logo. Use Poppins for UI and Lora for prose; numbers use the monospace face.
  - Use the CSS tokens in `style.css`.
- The chart palette (`--s1`…`--s5`) was validated for color-vision deficiency in light and dark mode. Re-validate it before changing any series color.
- **Logo:** the source is `design/logo/` (gitignored). `make-logo.py` writes `build/icon.svg`, `web/icon.svg`, `web/logo*.svg`, and `render-svg.mjs` renders the PNG. The header token's hover tilt is real CSS 3D with per-frame lighting (`web/logo-fx.js`). Light always comes from the top left.
- All user-visible text goes through `t()` in `web/i18n.js`, with both `zh-TW` and `en` entries.
- Light and dark modes are both required. Every color is a token defined for both.
