// Live observations and explicitly marked replays of received measurement windows.
const HOUR = 3600000, DAY = 24 * HOUR;
const dateKey = t => new Date(t + 8 * HOUR).toISOString().slice(0, 10);
const quantile = (sorted, fraction) => {
  const index = (sorted.length - 1) * fraction, lo = Math.floor(index);
  return sorted[lo] + (sorted[Math.ceil(index)] - sorted[lo]) * (index - lo);
};
export class PressureHistory {
  constructor(sql) {
    this.sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS pressure_observations (
      rule TEXT NOT NULL, context TEXT NOT NULL, evidence_at REAL NOT NULL, source TEXT NOT NULL,
      score REAL NOT NULL, confidence TEXT, recorded_at REAL NOT NULL, evaluated_at REAL NOT NULL,
      PRIMARY KEY(rule,context,evidence_at,source))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS pressure_observation_basis (
      rule TEXT NOT NULL, context TEXT NOT NULL, evidence_at REAL NOT NULL, source TEXT NOT NULL,
      basis TEXT NOT NULL, PRIMARY KEY(rule,context,evidence_at,source))`);
    sql.exec('CREATE INDEX IF NOT EXISTS pressure_time ON pressure_observations(evidence_at)');
    sql.exec('CREATE INDEX IF NOT EXISTS pressure_basis_time ON pressure_observation_basis(evidence_at)');
    sql.exec('CREATE TABLE IF NOT EXISTS pressure_history_meta (id INTEGER PRIMARY KEY, since REAL NOT NULL)');
  }
  record(indices, now, basis = 'live') {
    this.sql.exec('INSERT OR IGNORE INTO pressure_history_meta(id,since) VALUES(1,?)', now);
    this.sql.exec('DELETE FROM pressure_observations WHERE evidence_at < ?', now - 35 * DAY);
    this.sql.exec('DELETE FROM pressure_observation_basis WHERE evidence_at < ?', now - 35 * DAY);
    const night = indices?.nightlyEvidence;
    if (night?.status === 'unavailable') this.sql.exec(
      "DELETE FROM pressure_observations WHERE rule=? AND context='nightly' AND evidence_at=?", indices.ruleVersion, night.evidenceAt);
    const p = indices?.pressure;
    if (!p || !Number.isFinite(p.evidenceAt)) return;
    // Natural expiry is not a correction. A newly discovered conflict/exclusion is.
    const invalidReason = p.primaryReason ?? p.reason;
    if (['source_or_sample_conflict', 'sleeping', 'sleep_or_workout', 'missing_or_conflicting_aligned_hr', 'short_baseline', 'insufficient_samples'].includes(invalidReason)) {
      const anchor = indices.features?.hrv?.measuredAt ?? p.evidenceAt;
      this.sql.exec("DELETE FROM pressure_observations WHERE rule=? AND context='awake_sample' AND evidence_at=?", indices.ruleVersion, anchor);
    }
    if (!Number.isFinite(p.score) || !['awake_sample', 'nightly'].includes(p.context)) return;
    // Old writers have no basis row. Resolve only this anchor instead of scanning
    // every observation on each cold start; read-only history uses COALESCE('live').
    this.sql.exec(`INSERT OR IGNORE INTO pressure_observation_basis
      SELECT rule,context,evidence_at,source,'live' FROM pressure_observations
      WHERE rule=? AND context=? AND evidence_at=? AND source=?`,
      indices.ruleVersion, p.context, p.evidenceAt, p.source ?? 'unknown');
    this.sql.exec(`INSERT INTO pressure_observations VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(rule,context,evidence_at,source) DO UPDATE SET
      score=excluded.score,confidence=excluded.confidence,evaluated_at=excluded.evaluated_at`,
      indices.ruleVersion, p.context, p.evidenceAt, p.source ?? 'unknown', p.score,
      p.confidence ?? null, now, indices.evaluatedAt ?? now);
    this.sql.exec(`INSERT INTO pressure_observation_basis VALUES(?,?,?,?,?)
      ON CONFLICT(rule,context,evidence_at,source) DO UPDATE SET
      basis=CASE WHEN pressure_observation_basis.basis='live' OR excluded.basis='live' THEN 'live' ELSE excluded.basis END`,
      indices.ruleVersion, p.context, p.evidenceAt, p.source ?? 'unknown', basis);
  }
  latest(now, ruleVersion, source) {
    if (!source || source === 'unknown') return null;
    return this.sql.exec(`SELECT rule AS ruleVersion,context,evidence_at AS evidenceAt,source,score,confidence
      FROM pressure_observations WHERE rule=? AND source=? AND evidence_at>? AND evidence_at<=?
      AND context IN ('awake_sample','nightly') ORDER BY evidence_at DESC LIMIT 1`,
      ruleVersion, source, now - 35 * DAY, now).toArray()[0] ?? null;
  }
  view(now, range) {
    const start = now - (range === '7d' ? 7 : 1) * DAY;
    // Include the entire first calendar day for daily aggregates; points retain the rolling window.
    const dayStart = Math.floor((start + 8 * HOUR) / DAY) * DAY - 8 * HOUR;
    const rows = this.sql.exec(`SELECT p.rule AS ruleVersion,p.context,p.evidence_at AS t,p.source,p.score,p.confidence,
      p.recorded_at AS recordedAt,COALESCE(b.basis,'live') AS basis FROM pressure_observations p
      LEFT JOIN pressure_observation_basis b ON p.rule=b.rule AND p.context=b.context AND p.evidence_at=b.evidence_at AND p.source=b.source
      WHERE p.evidence_at>=? AND p.evidence_at<=? ORDER BY p.evidence_at,p.rule,p.source`, dayStart, now).toArray();
    const days = [];
    for (let t = dayStart; t <= now; t += DAY) {
      const date = dateKey(t), group = rows.filter(r => r.context === 'awake_sample' && dateKey(r.t) === date);
      const versions = [...new Set(group.map(r => r.ruleVersion))];
      const sources = [...new Set(group.map(r => r.source))];
      const count = group.length, spanMinutes = count ? (group.at(-1).t - group[0].t) / 60000 : 0;
      const status = !count ? 'missing' : versions.length > 1 ? 'mixed_rules' : sources.length > 1 ? 'mixed_sources' : count < 3 || spanMinutes < 120 ? 'insufficient_samples' : 'available';
      const scores = group.map(r => r.score).sort((a, b) => a - b), available = status === 'available';
      days.push({ date, count, spanMinutes, status, partial: date === dateKey(now),
        replayedCount: group.filter(r => r.basis === 'received_records_replay').length,
        confidence: group.some(r => r.confidence === 'short_baseline') ? 'short_baseline'
          : group.length && group.every(r => r.confidence === 'personal_baseline') ? 'personal_baseline' : null,
        ruleVersion: versions.length === 1 ? versions[0] : null,
        sourceScope: sources.length === 1 && sources[0].startsWith('hae-profile:') ? sources[0] : null,
        median: available ? quantile(scores, .5) : null, q1: available ? quantile(scores, .25) : null,
        q3: available ? quantile(scores, .75) : null,
        highFraction: available ? scores.filter(s => s > 60).length / count : null });
    }
    const publicRows = rows.map(({ source, ...row }) => row);
    return { points: publicRows.filter(r => r.t >= start && r.context === 'awake_sample'), days,
      nights: publicRows.filter(r => r.t >= start && r.context === 'nightly'),
      since: this.sql.exec('SELECT since FROM pressure_history_meta WHERE id=1').toArray()[0]?.since ?? null };
  }
}
