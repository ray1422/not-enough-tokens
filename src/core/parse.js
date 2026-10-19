// Turn one Claude Code transcript line into a usage record (or null).
//
// Things the raw logs do that matter here:
// - A streamed assistant message is written as several lines sharing message.id;
//   the token counts grow across those lines, so callers keep the max per id.
// - Forked/resumed sessions copy old lines into a new file (same message.id).
// - Some lines carry zeros at the top level and the real numbers in usage.iterations.

const n = (v) => (Number.isFinite(v) ? v : 0);

function countsOf(u) {
  const cc = u.cache_creation;
  const split = cc && (cc.ephemeral_5m_input_tokens != null || cc.ephemeral_1h_input_tokens != null);
  return {
    input: n(u.input_tokens),
    output: n(u.output_tokens),
    cacheRead: n(u.cache_read_input_tokens),
    cacheWrite5m: split ? n(cc.ephemeral_5m_input_tokens) : n(u.cache_creation_input_tokens),
    cacheWrite1h: split ? n(cc.ephemeral_1h_input_tokens) : 0,
  };
}

export function maxCounts(a, b) {
  return {
    input: Math.max(a.input, b.input),
    output: Math.max(a.output, b.output),
    cacheRead: Math.max(a.cacheRead, b.cacheRead),
    cacheWrite5m: Math.max(a.cacheWrite5m, b.cacheWrite5m),
    cacheWrite1h: Math.max(a.cacheWrite1h, b.cacheWrite1h),
  };
}

export function parseLine(line, fallbackProject) {
  if (!line.includes('"usage"')) return null;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  const m = o?.message;
  const u = m?.usage;
  if (!u || typeof u !== 'object' || !m.model || m.model === '<synthetic>') return null;
  const ts = Date.parse(o.timestamp);
  if (!Number.isFinite(ts)) return null;

  let tokens = countsOf(u);
  if (Array.isArray(u.iterations) && u.iterations.length) {
    const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
    for (const it of u.iterations) {
      const c = countsOf(it);
      for (const k in sum) sum[k] += c[k];
    }
    tokens = maxCounts(tokens, sum);
  }

  return {
    id: m.id || o.requestId || o.uuid,
    ts,
    model: u.speed === 'fast' ? `${m.model}@fast` : m.model,
    project: o.cwd || fallbackProject || '(unknown)',
    tokens,
  };
}

// "~/.claude/projects/-Users-me-code-foo/abc.jsonl" -> "-Users-me-code-foo"
export function projectFromPath(p) {
  const parts = p.split('/');
  const i = parts.lastIndexOf('projects');
  return i >= 0 && parts[i + 1] ? parts[i + 1] : parts[parts.length - 2] || '(unknown)';
}
