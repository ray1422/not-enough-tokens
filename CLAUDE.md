# not-enough-tokens

Incremental Claude Code usage tracker: reads transcript JSONL on this machine and on remotes over SSH, stores token counts and frozen list-price cost, and shows them in a local web console that is also packaged with Electron.

- [README.md](README.md): what it does and how to run it.
- [docs/architecture.md](docs/architecture.md): layout, data files, counting, sync, SSH, security.
- [docs/ui.md](docs/ui.md): corners, color, text, logo.

Update the doc that owns a topic when you change it; keep this file to the rules below.

## Develop

```bash
node src/cli.js serve          # open the printed ?token= URL once in the built-in browser
NET_DATA_DIR=/tmp/x node ...   # scratch data dir for tests
```

Packaging (dmg, AppImage, Arch, Nix) is listed in README.md; `packaging/linux/` is shared by the Arch package and `install.sh`. CI runs only for the `release` branch: PRs into it are a build check, a merge publishes GitHub Release `v<version>`, so bump `package.json` first.

No runtime dependencies, Node ≥ 20, no build step for `web/`.

## Rules

- **No auth bypass.** Loopback only, token on every request, Host check, `X-NET` on writes. Don't add a way to turn any of it off.
- **Remote machines are read-only.** Only find/stat/tail/grep/python; never write or install there.
- **Never delete collected data implicitly.** Claude Code deletes old transcripts, so `machines/<id>/` may be the only record. Only an explicit user choice removes it.
- **Don't recompute stored costs.** Cost is frozen at ingest; unpriced tokens wait in `u_*`.
- **macOS:** never touch `/home`, `/net`, `/Network` or `/Volumes` (network-volume privacy prompt).
- **Testing:** a full re-read is ~3 GB. Use small inputs or a copy, and don't loop full syncs.
- **UI:** G2 corners via `corner-shape: squircle` and `--r-*` tokens (never raw `border-radius`); colors only from tokens, in light and dark; all text through `t()` with `zh-TW` and `en`. Details in docs/ui.md.
