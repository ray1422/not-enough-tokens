// settings.json: how periods are cut. Shared by the server and the sync process
// (which needs the timezone/day boundary to compact old hourly buckets into days).
import path from 'node:path';
import { dataDir, readJson, writeJson } from './store.js';

const file = () => path.join(dataDir(), 'settings.json');

export function defaultSettings() {
  return {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    dayStartHour: 0,
    weekStartDow: 1, // Monday
    weekStartHour: 0,
    monthStartDay: 1,
    monthStartHour: 0,
  };
}

export const loadSettings = () => ({ ...defaultSettings(), ...readJson(file(), {}) });
export const saveSettings = (s) => writeJson(file(), s);

const H = 3600_000, D = 24 * H;
const fmts = new Map();

// Local wall-clock time of an epoch hour, encoded as UTC ms.
function wallOf(hour, tz) {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' });
    fmts.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(hour * H)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24);
}

// Epoch hour at which the local day containing `hour` starts (per dayStartHour).
export function dayStartHour(hour, s) {
  const w = wallOf(hour, s.timezone);
  const dayWall = Math.floor((w - s.dayStartHour * H) / D) * D + s.dayStartHour * H;
  return hour - Math.round((w - dayWall) / H);
}
