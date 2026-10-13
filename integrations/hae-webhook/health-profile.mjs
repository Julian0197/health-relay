// Bind this single-watch HAE exporter explicitly; keep received provenance unchanged.
export function healthProfile(env) {
  const id = env.HEALTH_DEVICE_PROFILE, start = env.HEALTH_DEVICE_EPOCH_START;
  const reportedSource = env.HEALTH_REPORTED_SOURCE;
  if (!id && !start && !reportedSource) return null;
  const since = Date.parse(start);
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id ?? '') || !Number.isFinite(since) ||
    typeof reportedSource !== 'string' || !reportedSource.trim() || reportedSource.length > 200) {
    throw new Error('Incomplete or invalid health device profile');
  }
  return { id, since, reportedSource };
}
const normalized = value => String(value ?? '').normalize('NFKC').trim().toLowerCase();
const belongs = (source, profile) => !source || source === 'unknown' ||
  normalized(source) === normalized(profile.reportedSource);
export function scopeHealthSeries(series, profile) {
  if (!profile) return series;
  const scope = rows => (rows ?? []).filter(r => r.start >= profile.since).map(r => ({ ...r,
    reportedSource: r.source ?? 'unknown',
    source: belongs(r.source, profile) ? `hae-profile:${profile.id}` : 'unknown' }));
  return { ...series, hrv: scope(series.hrv), heart: scope(series.heart) };
}
export function scopePressureSleep(sessions, profile) {
  if (!profile) return sessions;
  return sessions.map(s => s.start >= profile.since && s.sources.every(source => belongs(source, profile))
    ? { ...s, sources: [`hae-profile:${profile.id}`] } : s);
}
