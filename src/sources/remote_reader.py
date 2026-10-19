# Runs on the remote machine (python3 >= 3.6, stdlib only, read-only).
# Reads each file from its offset up to the last complete line, parses usage
# lines like src/core/parse.js does, merges streaming duplicates (max per id)
# and prints one compact record per message:
#   @@NET F <idx> <newOffset>
#   [id, timestamp, model, project, input, output, cacheRead, cacheWrite5m, cacheWrite1h]
#   @@NET E <idx>
import base64, json, sys

TODO = json.loads(base64.b64decode("@@TODO@@").decode("utf-8"))  # [[path, offset, length], ...]
out = sys.stdout


def n(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else 0


def counts(u):
    cc = u.get("cache_creation")
    split = isinstance(cc, dict) and (
        cc.get("ephemeral_5m_input_tokens") is not None or cc.get("ephemeral_1h_input_tokens") is not None
    )
    return [
        n(u.get("input_tokens")),
        n(u.get("output_tokens")),
        n(u.get("cache_read_input_tokens")),
        n(cc.get("ephemeral_5m_input_tokens")) if split else n(u.get("cache_creation_input_tokens")),
        n(cc.get("ephemeral_1h_input_tokens")) if split else 0,
    ]


def parse(line, fallback_project):
    try:
        o = json.loads(line)
    except ValueError:
        return None
    m = o.get("message") if isinstance(o, dict) else None
    if not isinstance(m, dict):
        return None
    u = m.get("usage")
    model = m.get("model")
    if not isinstance(u, dict) or not model or model == "<synthetic>" or not o.get("timestamp"):
        return None
    t = counts(u)
    its = u.get("iterations")
    if isinstance(its, list) and its:
        s = [0] * 5
        for it in its:
            if isinstance(it, dict):
                c = counts(it)
                s = [a + b for a, b in zip(s, c)]
        t = [max(a, b) for a, b in zip(t, s)]
    if u.get("speed") == "fast":
        model = model + "@fast"
    rid = m.get("id") or o.get("requestId") or o.get("uuid")
    return [rid, o["timestamp"], model, o.get("cwd") or fallback_project or "(unknown)"] + t


def project_of(p):
    parts = p.split("/")
    if "projects" in parts:
        i = len(parts) - 1 - parts[::-1].index("projects")
        if i + 1 < len(parts) - 1:
            return parts[i + 1]
    return parts[-2] if len(parts) > 1 else "(unknown)"


for idx, (path, off, length) in enumerate(TODO):
    proj = project_of(path)
    recs = {}
    order = []
    pos = off
    try:
        # Stream line by line: memory stays at one line plus one record per message.
        with open(path, "rb") as f:
            f.seek(off)
            remaining = length
            while remaining > 0:
                raw = f.readline(remaining)
                if not raw or not raw.endswith(b"\n"):
                    break  # end of range, or a line still being written
                remaining -= len(raw)
                pos += len(raw)
                if b'"usage"' not in raw:
                    continue
                r = parse(raw.decode("utf-8", "replace"), proj)
                if r is None:
                    continue
                prev = recs.get(r[0])
                if prev is None:
                    recs[r[0]] = r
                    order.append(r[0])
                else:
                    for k in range(4, 9):
                        prev[k] = max(prev[k], r[k])
    except (IOError, OSError):
        out.write("@@NET GONE %d\n" % idx)
        continue
    out.write("@@NET F %d %d\n" % (idx, pos))
    for rid in order:
        out.write(json.dumps(recs[rid], separators=(",", ":"), ensure_ascii=False))
        out.write("\n")
    out.write("@@NET E %d\n" % idx)
out.flush()
