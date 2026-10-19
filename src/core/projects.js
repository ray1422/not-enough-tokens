// Maps each working directory seen in the logs to the git repo it belongs to, so
// worktrees, sub-directories and separate clones can be grouped in the console.
//   machines/<id>/projects.json  { "<cwd>": { v, root, top, remote } }
//   root = main repo (worktrees map back to it), top = this checkout's own root.
// Resolved once per new cwd, on the machine that owns the path, with read-only git.
import path from 'node:path';
import { readJson, writeJson } from './store.js';
import { machineDir } from './ledger.js';
import { LineSplitter } from './lines.js';

const VERSION = 2; // bump to re-resolve every path after changing the script
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const file = (id) => path.join(machineDir(id), 'projects.json');

export const loadProjects = (id) => readJson(file(id), {});
export const saveProjects = (id, map) => writeJson(file(id), map);

// For a path that may no longer exist (cleaned-up worktree), git is asked from the
// nearest existing ancestor; --git-common-dir maps a worktree back to its main repo.
export function resolveScript(paths) {
  const calls = paths.map((p, i) => `res ${i} ${q(p)}`).join('\n');
  return `
git_ok=1
command -v git >/dev/null 2>&1 || git_ok=
if [ -n "$git_ok" ] && [ "$(uname -s)" = Darwin ] && [ "$(command -v git)" = /usr/bin/git ] && ! xcode-select -p >/dev/null 2>&1; then git_ok=; fi
os=$(uname -s)
res() {
  d=$2
  # macOS: /home, /net, /Network and /Volumes are automount/network/external
  # volumes; even testing a path there triggers a privacy prompt. Paths like
  # /home/<user>/... in a Mac's logs come from remote sessions anyway.
  if [ "$os" = Darwin ]; then
    case $d in /home/*|/net/*|/Network/*|/Volumes/*) printf '@@NET R %s\\t\\t\\t\\n' "$1"; return ;; esac
  fi
  while [ -n "$d" ] && [ "$d" != / ] && [ ! -d "$d" ]; do d=$(dirname "$d"); done
  root=; top=; remote=
  if [ -n "$git_ok" ] && [ -d "$d" ]; then
    c=$(git -C "$d" rev-parse --git-common-dir 2>/dev/null)
    if [ -n "$c" ]; then
      case $c in /*) ;; *) c="$d/$c" ;; esac
      c=$(cd "$c" 2>/dev/null && pwd -P)
      top=$(git -C "$d" rev-parse --show-toplevel 2>/dev/null)
      # A submodule's common dir lives inside the parent's .git/modules: use its own top.
      case $c in */.git) root=\${c%/.git} ;; */.git/*) root=$top ;; *) root=$c ;; esac
      remote=$(git -C "$d" config --get remote.origin.url 2>/dev/null)
    fi
  fi
  printf '@@NET R %s\\t%s\\t%s\\t%s\\n' "$1" "$root" "$top" "$remote"
}
${calls}
`;
}

export function parseResolveOutput(paths, onData) {
  const out = {};
  const sp = new LineSplitter((buf) => {
    const m = /^@@NET R (\d+)\t([^\t]*)\t([^\t]*)\t(.*)$/.exec(buf.toString('utf8'));
    if (m && paths[+m[1]] != null) out[paths[+m[1]]] = { v: VERSION, root: m[2] || null, top: m[3] || null, remote: m[4] || null };
  });
  return { push: (c) => sp.push(c), result: out };
}

// Resolve cwds the map doesn't know yet. `exec(script, onData)` runs sh on the machine.
export async function resolveNewProjects(id, cwds, exec) {
  const map = loadProjects(id);
  const todo = [...new Set(cwds)].filter((p) => p && p.startsWith('/') && map[p]?.v !== VERSION);
  if (!todo.length) return 0;
  const parser = parseResolveOutput(todo, null);
  await exec(resolveScript(todo), (c) => parser.push(c));
  for (const p of todo) map[p] = parser.result[p] || { v: VERSION, root: null, top: null, remote: null };
  saveProjects(id, map);
  return todo.length;
}
