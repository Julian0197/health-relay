import { normalizeNativeRecord } from './native-domain.mjs';
import { summarizeNativeActivity } from './native-activity.mjs';
const DAY = 86400000, HOUR = 3600000;
const midnight = t => Math.floor((t+8*HOUR)/DAY)*DAY-8*HOUR;
const groupKey = row => JSON.stringify([midnight(row.start), row.metric, row.source]);
const compare = (a,b) => a < b ? -1 : a > b ? 1 : 0;

// Daily sums/counts are incremental; precise HR/HRV and sleep intervals stay intact.
// Keeping the first identity preserves the legacy converter's source/label choice.
export class NativeDayProjection {
  constructor(records, stats) {
    this.stats = stats; this.records = records;
    this.detail = new Map(); this.daily = new Map();
    for (const [key, raw] of records) this.add(key, raw);
  }
  normalize(raw) { this.stats.normalizedRecords++; return normalizeNativeRecord(raw); }
  add(key, raw) {
    const row = this.normalize(raw); if (!row) return;
    if (row.kind !== 'daily') { this.detail.set(key, { row, raw }); return; }
    const id = groupKey(row); let group = this.daily.get(id);
    if (!group) {
      group = { row, firstKey: key, device: raw.source.device, total: 0, n: 0, maxEnd: row.end };
      this.daily.set(id, group);
    }
    if (compare(key, group.firstKey) <= 0) { group.row = row; group.firstKey = key; group.device = raw.source.device; }
    group.total += row.value; group.n++; group.maxEnd = Math.max(group.maxEnd, row.end);
  }
  update(changes) {
    const repair = new Set();
    for (const [key, after] of changes) {
      const before = this.records.get(key);
      if (before) {
        const old = this.normalize(before);
        if (old?.kind === 'daily') {
          const id = groupKey(old), group = this.daily.get(id);
          group.total -= old.value; group.n--;
          if (!group.n) this.daily.delete(id);
          else {
            const replacement = after && normalizeNativeRecord(after);
            const same = replacement?.kind === 'daily' && groupKey(replacement) === id;
            if ((group.firstKey === key && !same) ||
              (group.maxEnd === old.end && (!same || replacement.end < old.end))) repair.add(id);
          }
        } else this.detail.delete(key);
      }
      if (after) { this.records.set(key, after); this.add(key, after); }
      else this.records.delete(key);
    }
    // Extremum/first-record removal is uncommon. Repair only affected buckets.
    // Ordinary replacements with unchanged identity/time need no full bucket scan.
    for (const id of repair) {
      this.daily.delete(id);
      for (const [key, raw] of this.records) {
        if (raw.op === 'delete' || !raw.typeIdentifier.startsWith('HKQuantityTypeIdentifier') ||
          ['HKQuantityTypeIdentifierHeartRate','HKQuantityTypeIdentifierHeartRateVariabilitySDNN'].includes(raw.typeIdentifier)) continue;
        const row = normalizeNativeRecord(raw);
        if (row?.kind === 'daily' && groupKey(row) === id) this.add(key, raw);
      }
    }
  }
}

export function projectedSeries(projections, now, range = null) {
  const result = { hrv: [], heart: [], sleep: [], daily: [], workout: [] }, daily = new Map(), live = [];
  const cutoff = range === '24h' ? now-DAY : range === '7d' ? now-7*DAY : -Infinity;
  const nativeTimes = new Set();
  for (const projection of projections) {
    for (const { row } of projection.detail.values()) {
      if (row.end < now-35*DAY) continue;
      if (row.kind === 'heart') nativeTimes.add(row.start);
      if (row.liveHeart) live.push(row.liveHeart);
      if (['heart','hrv'].includes(row.kind) && row.end < cutoff) continue;
      result[row.kind].push(row);
    }
    for (const [key, group] of projection.daily) {
      let combined = daily.get(key);
      if (!combined) { combined = { ...group }; daily.set(key, combined); }
      else { combined.total += group.total; combined.n += group.n; }
    }
  }
  result.daily = [...daily.values()].map(({ row, total, n }) => {
    const { sum, ...value } = row;
    return { ...value, start: midnight(row.start), end: midnight(row.start), value: sum ? total : total/n };
  });
  result.heart.push(...live.filter(r => !nativeTimes.has(r.start) && r.end >= cutoff));
  for (const rows of Object.values(result)) rows.sort((a,b) => a.start-b.start || a.id.localeCompare(b.id));
  return result;
}

export function projectedActivity(projections, now) {
  const today = midnight(now), records = [];
  for (const projection of projections) {
    for (const group of projection.daily.values()) {
      const { row } = group;
      if (row.metric !== 'step_count' || midnight(row.start) !== today) continue;
      if (group.maxEnd > now) {
        // The protocol permits one minute of clock skew; exclude future facts exactly.
        for (const raw of projection.records.values()) if (raw.typeIdentifier === 'HKQuantityTypeIdentifierStepCount' &&
          raw.source.id === row.source && midnight(Date.parse(raw.start)) === today) records.push(raw);
      } else records.push({ op: 'upsert', typeIdentifier: 'HKQuantityTypeIdentifierStepCount',
        start: new Date(today).toISOString(), end: new Date(group.maxEnd).toISOString(),
        source: { id: row.source, device: group.device }, payload: { value: group.total, unit: 'count' } });
    }
    for (const { row, raw } of projection.detail.values()) if (row.kind === 'workout') records.push(raw);
  }
  return summarizeNativeActivity(records, now);
}

export function projectedMetadata(projections, series, now) {
  const channels = Object.fromEntries(['hrv','heart','daily','sleep','workout','recoveryHrv'].map(k => [k, { count: 0, latestAt: null }]));
  const nativeTimes = new Set(), live = [], workoutHeart = [];
  const history = series.workout.filter(w => w.start >= now-30*DAY && w.end <= now);
  let dataUpdatedAt = null;
  const observe = row => {
    dataUpdatedAt = Math.max(dataUpdatedAt ?? -Infinity, row.end);
    if (row.end > now) return;
    const kind = row.kind === 'hrv' && row.method === 'RMSSD' ? 'recoveryHrv' : row.kind;
    const channel = channels[kind]; channel.count++;
    channel.latestAt = Math.max(channel.latestAt ?? -Infinity, kind === 'daily' ? row.start : row.end);
    if (row.kind === 'heart' && history.some(w => row.start >= w.start && row.end <= w.end)) workoutHeart.push(row);
  };
  for (const p of projections) for (const { row } of p.detail.values()) {
    if (row.end < now-35*DAY) continue;
    if (row.kind === 'heart') nativeTimes.add(row.start);
    if (row.liveHeart) live.push(row.liveHeart);
    observe(row);
  }
  for (const row of live) if (!nativeTimes.has(row.start)) observe(row);
  for (const row of series.daily) observe(row);
  return { channels, dataUpdatedAt, workoutHeart };
}
