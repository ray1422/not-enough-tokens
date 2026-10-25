# Architecture

## Layout

- `src/core/`: storage, sync and pricing.
  - `ledger.js`: one machine's data — buckets, the dedupe map and file cursors.
  - `sync.js`: the incremental read. `sync-worker.js` runs each sync in a child process (`fork` with `ELECTRON_RUN_AS_NODE=1`), so its memory goes back to the OS afterwards. Machine updates travel back over IPC and are written by the main process.
  - `machines.js`: `machines.json`, plus each data folder's `identity.json`.
  - `pricing.js`: the LiteLLM table and manual prices. `projects.js`: cwd → git repo. `settings.js`: timezone and period boundaries.
- `src/sources/`: where transcripts come from. `local.js` reads this machine; `ssh.js` reads remotes, with `remote_reader.py` running on the remote side in python mode.
- `src/server.js`: HTTP API, SSE (sync log, askpass prompts) and the askpass endpoint. `src/cli.js`: `serve`, `sync`, `prices`.
- `electron/main.js`: starts the same server in-process on a random port and opens a sandboxed, context-isolated window. Other origins open in the system browser; permission requests are denied.
- `packaging/linux/`: launcher, `.desktop`, `install.sh` and PKGBUILD for the distro's electron.
- `packaging/install.sh`: one-line installer that picks dmg, pacman package, AppImage or the nix hint by system; `packaging/mac/install.sh` is the macOS part.
- `packaging/test/`: `test-install.sh` checks the installer's choice for an `os-release` sample of each branch (`NET_DRY_RUN=1`); CI `install-test` also runs it for real in an Ubuntu and an Arch container.
- `web/`: no-build ES modules. `app.js` (main view), `settings.js`, `core.js` (state, API, formatting, period math), `i18n.js`, `logo-fx.js`, `style.css`.

## Data

All under the data dir (`NET_DATA_DIR`, else `$XDG_DATA_HOME/not-enough-tokens`, else `~/.local/share/not-enough-tokens`). Writes are atomic (temp file, then rename).

| File | Contents |
| --- | --- |
| `machines.json` | Machine list: `id` (ours, never changes), host, `altHosts`, ssh options, `fingerprint`, last host/address/sync/error |
| `machines/<id>/usage_hourly.csv` | Buckets by (hour, project, model) |
| `machines/<id>/seen.json` | Counts already added per `message.id`, kept 90 days |
| `machines/<id>/cursors.json` | Per-file inode and byte offset |
| `machines/<id>/projects.json` | cwd → git common dir, toplevel and origin URL |
| `machines/<id>/identity.json` | The machine's fingerprint, kept next to its data |
| `prices.json` | Fetched table, manual overrides, `fetchedAt` |
| `settings.json` | Locale, timezone, day/week/month start |
| `server-token` | Access token, mode 0600 |

CSV columns: `hour, span, project, model, msgs`, then for each token kind (`input, output, cacheRead, cacheWrite5m, cacheWrite1h`) the priced tokens, `c_<kind>` (USD) and `u_<kind>` (tokens without a price yet). `span` is 1 for an hourly bucket and 24 for a daily one.

## Counting

- **Dedupe by `message.id` with max-merge.** Streamed lines repeat the same id with growing counts, and forks copy lines into other files. The counts of a line are the larger of the top-level `usage` and the sum of `usage.iterations`. A delta always lands in the hour the message was first seen.
- **Fast mode** models get an `@fast` suffix; they are priced manually only.
- **Cost is frozen at ingest** with the price current then. Unpriced tokens stay in `u_*` until priced from the Prices tab; old costs are never recomputed.
- **Compaction:** buckets older than 35 days are merged into one bucket per local day (respecting the day-start hour), so the file stops growing by the hour. Totals stay identical.
- **Period math** (timezone, week and month start, to the hour) runs in the browser.

## Sync

1. Connect and read the machine's fingerprint (`/etc/machine-id`, or `IOPlatformUUID` on macOS) and the list of `.jsonl` files with inode and size.
2. Check the fingerprint. A mismatch stops the sync; so does a second entry for the same box, which is marked `twinOf` so the console can offer to fold its address into the existing machine (as a fallback or as the new main host) and drop the duplicate. On first contact, if a removed machine left data with the same fingerprint, that folder is taken over instead of re-reading everything.
3. Read only the bytes after each cursor, stopping at the last newline. A changed inode or a shrunk file is read again from the start; the dedupe map makes that harmless.
4. Save, then map new project paths to git repos.

## SSH

- The system `ssh` with a ControlMaster socket in `/tmp/net-ssh-<uid>/`, so one sync asks for a password at most once.
- **macOS Local Network privacy** blames a connection on its responsible process, which for ssh spawned by the app is the app. The ad-hoc signed app never gets the permission prompt (it isn't even listed in System Settings) and LAN hosts fail with "No route to host". So the packaged app runs ssh through `net-disclaim` (`packaging/mac/disclaim.c`, built by `dist:mac`, installed in the app's `Contents/MacOS`; found from the outermost `.app` in `execPath`, since Electron forks the sync worker as its Helper binary under `Contents/Frameworks`): it execs ssh with `responsibility_spawnattrs_setdisclaim`, making ssh its own responsible process, and command-line tools aren't subject to the check. That call is private, so it's weak-linked: if macOS drops it, the helper still execs the command, just undisclaimed. From source, ssh runs directly and the terminal is responsible.
- Prompts go through `SSH_ASKPASS` (`askpass.sh`), which calls `/api/askpass` with its own bearer token; the console shows the dialog.
- `host`, then each of `altHosts`. When another address is left, an unreachable host (ssh exit 255) or one that answers with a different fingerprint is skipped after a 6 s connect timeout. Fallbacks are connected with `HostKeyAlias=<host>`, so they are checked against the host key already trusted for the main host rather than prompting per address; a different key still fails.
- **Changed host key** (a floating IP now belongs to another box, or a reinstall): ssh refuses without prompting. The parsed details (new key fingerprint, the `known_hosts` file and entry ssh named) are kept as `hostKeyIssue`, and the console explains it. Only for the main host can the user forget the old entry (`ssh-keygen -R`, on the file ssh named); the next connection then asks to trust the new key, and the machine fingerprint must still match before anything is read.
- **Read modes:** python (python3 ≥ 3.6 parses on the remote and sends compact records) or shell (tail/head/grep send raw lines). Output is gzipped when the remote has gzip. On macOS the `/usr/bin/python3` stub is skipped when the Command Line Tools are missing, since it would pop an install dialog.

## Discover

`src/core/discover.js`, behind `GET /api/discover`; passive only, no port scans.

- **mDNS:** PTR queries for `_ssh._tcp`, `_sftp-ssh._tcp`, `_companion-link._tcp` and `_airplay._tcp`. SSH services give the port; the AirPlay TXT `model=` tells Macs (which can turn on Remote Login) from phones and tablets, which the console marks as not computers. Linux hosts only appear when avahi announces ssh. On macOS this goes through mDNSResponder (`dns-sd -Z`, `dns-sd -G`, via `net-disclaim` for Local Network privacy); elsewhere it sends legacy unicast queries from a random UDP port itself, so no avahi is needed to look.
- **Tailscale:** `tailscale status --json` (PATH, Homebrew, or the macOS app's binary). That binary only behaves as the CLI when `TERM` or `SHLVL` is set, so it gets `TERM=dumb`; otherwise it starts as a second GUI and never exits. A stopped Tailscale exits non-zero but still prints the status.
- One entry per source and host, never merged: mDNS and Tailscale spell the same machine differently, and names prove nothing. An entry is marked with the machine it already is only by an address it was found under (host, fallbacks, last host or IP); testing the connection settles the rest by fingerprint and can add the entry's address as a fallback. Picking a new one fills the add form with a regular LAN IPv4 (then a 169.254 one, then the `.local` name, which needs avahi + nss-mdns to resolve on Linux) or the Tailscale name.
- **Test connection** (`POST /api/test-connection`, `testSsh` in `ssh.js`): one `ssh -o BatchMode=yes` login with the form's unsaved values, no prompts, no shared master and nothing written to `known_hosts`, through `net-disclaim` on macOS. The outcome is read from ssh's stderr: logs in, needs a password or key, host key not trusted or changed, refused, timed out, unreachable. A login runs the same fingerprint lines a sync does, and the response names the machine with that fingerprint (`known`). An untrusted host key is retried with each known machine's host as `HostKeyAlias`, the way fallbacks connect, so a Tailscale name for a LAN box is recognized; the retry counts only if the login reads that machine's fingerprint, otherwise the result stays "host key not trusted". It only runs when the user asks.

## Security

The usage data and the ability to run ssh make the console worth protecting, even on loopback: other local programs, and pages in any browser, can reach 127.0.0.1.

- Binds to loopback. `serve --host` warns when given anything else.
- Every request needs the token: given once as `?token=`, then traded for an HttpOnly, SameSite=Strict cookie named `net_token_<port>`, and removed from the address bar.
- The `Host` header must be a loopback name (DNS rebinding).
- Writes need an `X-NET` header, which a cross-site form can't send.
- Responses carry a strict CSP, `nosniff` and `no-referrer`.
