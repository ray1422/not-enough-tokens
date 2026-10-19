# Not Enough Tokens

Tracks how many tokens Claude Code uses, on this machine and on other machines over SSH, and what they would cost at list price. It reads the transcript files Claude Code keeps in `~/.claude/projects`, only reads what was appended since the last sync, and shows weekly, monthly and all-time totals by token type, model and project.

Linux and macOS only.

## Run

The console is a local web page. Use it from a browser, or as a desktop app.

```bash
node src/cli.js serve          # prints the console URL, including its access token
npm install && npx install-electron && npm run app    # desktop app from the checkout
```

## Packages

| Target | How | Electron |
| --- | --- | --- |
| macOS | `npm run dist:mac` → `dist/*.dmg` (unsigned, Apple silicon) | bundled |
| Any Linux | `npm ci --ignore-scripts && npm run dist:linux` → `dist/*.AppImage` (x86_64, arm64; needs FUSE 2, or run with `--appimage-extract-and-run`) | bundled |
| Arch | `cd packaging/arch && makepkg -si` (builds from this checkout) | system `electron` |
| NixOS / Nix | `nix run github:ray1422/not-enough-tokens`, or `packages.<system>.default` from the flake; `nix run …#cli` for the CLI only | nixpkgs `electron` |
| Other Linux | `sh packaging/linux/install.sh` (`PREFIX`, `DESTDIR`, `ELECTRON_BIN` honored) | system `electron` |

Releases go through the `release` branch in GitHub Actions; nothing runs for other branches.

1. Bump `version` in `package.json` on `main`.
2. Open a PR from `main` into `release`. It builds the AppImages, the Arch package and the Nix package as a check.
3. Merge it. The same builds run again and GitHub Release `v<version>` is published with the AppImages and the Arch package. Re-running the same commit refreshes its files; reusing a version on another commit fails. The dmg is built locally and can be attached to the release by hand.

Node ≥ 20, with no runtime dependencies. There is also a CLI: `node src/cli.js sync [id...]` syncs machines and `node src/cli.js prices` refreshes the price table.

The server only listens on 127.0.0.1 and every request needs a per-install token. Open the printed `?token=` link once; a cookie keeps you signed in after that.

## Machines

- **This machine** is added automatically.
- **Remote machines** are added in Settings → Machines, by IP, hostname or an alias from `~/.ssh/config`. They are reached with the system `ssh`, so keys, agents and ProxyJump all work. Password, passphrase and host-key prompts show up as dialogs in the console.
- Nothing is written or installed on a remote. If it has python3 ≥ 3.6, the records are parsed there and only compact results come back; otherwise plain shell tools are used.
- **Changing addresses:** list fallback hosts (for example a Tailscale name) under the machine. They are tried in order, and each is checked to be the same machine before anything is read. If you add a new address as a separate machine, the first sync notices it is one you already have and offers to merge it.
- **Removing** a machine keeps its collected data unless you tick delete. Add the same machine back later and it continues from that data. Claude Code deletes old transcripts, so the collected data may be the only record of older usage.

## Data

Everything lives in `~/.local/share/not-enough-tokens` (or `$XDG_DATA_HOME/not-enough-tokens`, or `NET_DATA_DIR`), as CSV and JSON. Prices come from the LiteLLM price table, and you can override any model by hand. Cost is fixed when the usage is collected, so later price changes don't rewrite history; usage of models without a price can be priced from the Prices tab.

More detail: [docs/architecture.md](docs/architecture.md) (data model, sync, SSH, security) and [docs/ui.md](docs/ui.md) (design rules).

## License

BSD 3-Clause. See [LICENSE](LICENSE).
