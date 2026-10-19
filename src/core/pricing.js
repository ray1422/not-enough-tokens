// Model prices, in USD per million tokens.
// Auto source: LiteLLM's community-maintained price table (Anthropic has no pricing API).
// Manual entries override auto ones and cover models the table doesn't know.
import path from 'node:path';
import { dataDir, readJson, writeJson } from './store.js';

export const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

export const KINDS = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'];

const pricesFile = () => path.join(dataDir(), 'prices.json');

export function loadPrices() {
  return readJson(pricesFile(), { fetchedAt: null, source: LITELLM_URL, auto: {}, manual: {} });
}

export function savePrices(p) {
  writeJson(pricesFile(), p);
}

const M = 1e6;

// Convert one LiteLLM entry (USD per token) into our shape (USD per MTok), tiers included.
export function fromLitellm(e) {
  const base = (suffix = '') => {
    const get = (k) => (typeof e[k + suffix] === 'number' ? e[k + suffix] * M : undefined);
    const p = {
      input: get('input_cost_per_token'),
      output: get('output_cost_per_token'),
      cacheRead: get('cache_read_input_token_cost'),
      cacheWrite5m: get('cache_creation_input_token_cost'),
      cacheWrite1h: get('cache_creation_input_token_cost_above_1hr'),
    };
    return p;
  };
  const p = base();
  if (p.input == null || p.output == null) return null;
  // Missing cache prices fall back to Anthropic's standard multipliers.
  p.cacheRead ??= p.input * 0.1;
  p.cacheWrite5m ??= p.input * 1.25;
  p.cacheWrite1h ??= p.input * 2;

  const thresholds = new Set();
  for (const k of Object.keys(e)) {
    const m = /^(?:input_cost_per_token|output_cost_per_token)_above_(\d+)k_tokens$/.exec(k);
    if (m) thresholds.add(Number(m[1]));
  }
  const tiers = [...thresholds].sort((a, b) => a - b).map((k) => {
    const t = base(`_above_${k}k_tokens`);
    return {
      above: k * 1000,
      input: t.input ?? p.input,
      output: t.output ?? p.output,
      cacheRead: t.cacheRead ?? p.cacheRead,
      cacheWrite5m: t.cacheWrite5m ?? p.cacheWrite5m,
      cacheWrite1h: t.cacheWrite1h ?? (t.cacheWrite5m != null ? t.cacheWrite5m * 1.6 : p.cacheWrite1h),
    };
  });
  if (tiers.length) p.tiers = tiers;
  return p;
}

export async function fetchAutoPrices(fetchImpl = fetch) {
  const res = await fetchImpl(LITELLM_URL, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`price fetch HTTP ${res.status}`);
  const json = await res.json();
  const auto = {};
  for (const [name, e] of Object.entries(json)) {
    if (!/claude/i.test(name) || e.litellm_provider !== 'anthropic') continue;
    const p = fromLitellm(e);
    if (p) auto[name] = p;
  }
  if (!Object.keys(auto).length) throw new Error('price table had no Anthropic models');
  return auto;
}

// Refresh the auto table; on failure keep the last snapshot (manual entries never touched).
export async function refreshPrices(fetchImpl) {
  const p = loadPrices();
  try {
    p.auto = await fetchAutoPrices(fetchImpl);
    p.fetchedAt = new Date().toISOString();
    p.lastError = null;
  } catch (e) {
    p.lastError = `${new Date().toISOString()} ${e.message}`;
  }
  savePrices(p);
  return p;
}

export function lookup(prices, model) {
  if (prices.manual?.[model]) return prices.manual[model];
  if (model.includes('@')) return null; // variants such as "@fast" are manual-only
  const auto = prices.auto || {};
  return auto[model] || auto[model.replace(/-\d{8}$/, '')] || auto[`anthropic/${model}`] || null;
}

// Cost in USD per token kind for one message. Tier is picked by total prompt size.
export function costParts(price, t) {
  const ctx = t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
  let p = price;
  for (const tier of price.tiers || []) if (ctx > tier.above) p = tier;
  return Object.fromEntries(KINDS.map((k) => [k, ((t[k] || 0) * (p[k] || 0)) / M]));
}

export const costOf = (price, t) => Object.values(costParts(price, t)).reduce((a, b) => a + b, 0);
