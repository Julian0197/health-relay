import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHealthIndices, scorePresentation } from './health-indices.mjs';
import { renderHealthSignature } from './health-signature.mjs';
const H = 3600000, D = 24 * H, T = Date.parse('2026-09-28T15:00:00+08:00');
function fixture() {
 const s = { hrv: [], heart: [], daily: [], sleep: [], workout: [] };
 for(let d=0;d<=5;d++) {
  s.hrv.push({kind:'hrv',start:T-d*D,value:d?60:30,method:'SDNN',source:'Watch',key:'v'+d});
  s.heart.push({kind:'heart',start:T-d*D,end:T-d*D+60000,value:d?60:75,source:'Watch',key:'h'+d});
  const end=T-d*D-7*H, start=end-8*H;
  s.sleep.push({start,end:start+4*H,stage:'core',source:'Watch'}, {start:start+4*H,end:start+4*H+600000,stage:'awake',source:'Watch'}, {start:start+4*H+600000,end,stage:'rem',source:'Watch'});
 }
 return s;
}
test('charging gaps retain the last valid four-tier heading without claiming a current score', () => {
 const now = T + 7 * H, r = evaluateHealthIndices(fixture(), now);
 r.lastValidPressure = { ruleVersion: r.ruleVersion, source: 'Watch', score: 20,
   context: 'awake_sample', evidenceAt: T - D };
 assert.equal(r.pressure.score, null);
 const title = renderHealthSignature(r, now);
 assert.match(title, /^🟢 状态优秀 /);
 assert.doesNotMatch(title, /压力暂无|今日|最近|上次|昨夜/);
 assert.match(title, /HRV30 心率75｜09\/28 15:00｜详情 ↗$/);
 assert.equal((title.match(/\d{2}\/\d{2} \d{2}:\d{2}/g) ?? []).length, 1);
 for (const change of [{ ruleVersion: 'old' }, { source: 'Other' }, { evidenceAt: now + H },
   { evidenceAt: now - 8 * D }, { score: null }]) {
  const changed = { ...r, lastValidPressure: { ...r.lastValidPressure, ...change } };
  assert.match(renderHealthSignature(changed, now), /压力暂无/);
 }
 const fresh = evaluateHealthIndices(fixture(), T + 60000);
 fresh.lastValidPressure = r.lastValidPressure;
 assert.match(renderHealthSignature(fresh, T + 60000), /^🔴 压力过载 /);
});
test('indices use time-aligned HR and personal baselines, not latest unrelated HR',()=>{
 const s=fixture(); s.heart.push({start:T+H,end:T+H+60000,value:140,source:'Watch'});
 const r=evaluateHealthIndices(s,T+H+60000);
 assert.ok(r.pressure.score >= 90 && r.pressure.score <= 96);
 assert.equal(r.features.heart.current,75);
 assert.equal(r.scoreAt,T);
 assert.equal(r.asOfAt,T+H);
 assert.match(r.title,/^🔴 压力过载 😴 睡眠99｜HRV30 心率140｜09\/28 16:00｜详情 ↗$/);
 assert.ok(Math.abs(r.sleep.components.duration - 50*470/480) < 1e-10);
 assert.equal(r.sleep.components.regularity,30);
});
test('missing or conflicting HR does not become zero stress',()=>{
 for(const mutate of [s=>s.heart=[],s=>s.heart.push({...s.heart[0],value:90}),s=>s.heart[0].source='Other']) {
  const s=fixture();mutate(s);const r=evaluateHealthIndices(s,T+60000);
  assert.equal(r.pressure.score,null); assert.match(r.title,/压力暂无/); assert.doesNotMatch(r.title,/待评估|待更新|—/);
 }
});
test('sleep and workouts exclude pressure evidence; duplicate records never increase coverage',()=>{
 const s=fixture();s.workout=[{start:T-60000,end:T+60000}];
 assert.equal(evaluateHealthIndices(s,T+60000).pressure.score,null);
 const a=fixture(), before=evaluateHealthIndices(a,T+60000);
 a.hrv.push({...a.hrv[0]});a.heart.push({...a.heart[0]});
 assert.deepEqual(evaluateHealthIndices(a,T+60000).pressure,before.pressure);
});
test('sparse baselines, expired HRV, and unknown source do not produce scores',()=>{
 const s=fixture();s.hrv=s.hrv.slice(0,3);
 assert.equal(evaluateHealthIndices(s,T+60000).pressure.score,null);
 assert.equal(evaluateHealthIndices(fixture(),T+6*H).pressure.score,null);
 const u=fixture();u.hrv[0].source='unknown';assert.equal(evaluateHealthIndices(u,T+60000).pressure.score,null);
});
test('sleep requires sufficient history and observed continuity; absent sleep is not zero quality',()=>{
 const a=fixture();a.sleep=[];assert.equal(evaluateHealthIndices(a,T+60000).sleep.score,null);
 const b=fixture();b.sleep=b.sleep.slice(0,3);assert.equal(evaluateHealthIndices(b,T+60000).sleep.score,null);
 const c=fixture();c.sleep=c.sleep.filter(r=>r.stage!=='awake');assert.equal(evaluateHealthIndices(c,T+60000).sleep.score,null);
 const d=fixture();d.sleep.push({...d.sleep[0],stage:'deep'});assert.equal(evaluateHealthIndices(d,T+60000).sleep.score,null);
});
test('score and timestamp are invariant to duplicate upload within the same freshness period',()=>{
 const s=fixture();const a=evaluateHealthIndices(s,T+60000), b=evaluateHealthIndices(s,T+20*60000);
 assert.equal(a.title,b.title);assert.equal(a.pressure.score,b.pressure.score);
 assert.equal(evaluateHealthIndices(s,T+6*H).pressure.score,null);
});

test('future workout in pairing window excludes exercise HR without discarding earlier resting pair', () => {
 const s=fixture();s.workout=[{start:T+10*60000,end:T+H}];
 s.heart.push({start:T+11*60000,end:T+12*60000,value:150,source:'Watch'});
 const r=evaluateHealthIndices(s,T+20*60000);
 assert.ok(r.pressure.score >= 90);assert.equal(r.pressure.excludedHeartWindows,1);
});
test('sleep waits an hour after last received segment before assigning a score', () => {
 const s=fixture(), now=T-7*H+60000;
 assert.equal(evaluateHealthIndices(s,now).sleep.reason,'sleep_settling');
 assert.equal(evaluateHealthIndices(s,now).validUntil,T-6*H);
});

 test('personal center maps to 50 and favorable observations remain distinguishable', () => {
  const s=fixture(); s.hrv[0].value=60; s.heart[0].value=60;
  assert.equal(evaluateHealthIndices(s,T+60000).pressure.score,50);
  s.hrv[0].value=66; s.heart[0].value=58;
  const mild=evaluateHealthIndices(s,T+60000).pressure.score;
  s.hrv[0].value=80; s.heart[0].value=52;
  const stronger=evaluateHealthIndices(s,T+60000).pressure.score;
  assert.ok(stronger > 0 && stronger < mild && mild < 50);
 });
 test('same deviation is less exceptional for a variable personal history', () => {
  const narrow=fixture(); narrow.hrv[0].value=50;narrow.heart[0].value=65;
  const wide=structuredClone(narrow);
  [30,45,60,80,100].forEach((v,i)=>wide.hrv[i+1].value=v);
  [40,50,60,75,90].forEach((v,i)=>wide.heart[i+1].value=v);
  assert.ok(evaluateHealthIndices(wide,T+60000).pressure.score < evaluateHealthIndices(narrow,T+60000).pressure.score);
 });
 test('newer heart updates displayed HR and measurement clock without changing pressure', () => {
  const s=fixture(), before=evaluateHealthIndices(s,T+60000);
  s.heart.push({start:T+H,end:T+H+60000,value:140,source:'Watch'});
  const after=evaluateHealthIndices(s,T+H+60000);
  assert.notEqual(before.title,after.title);
  assert.equal(before.pressure.score,after.pressure.score);
  assert.equal(after.scoreAt,T);
  assert.equal(after.asOfAt,T+H);
  assert.doesNotMatch(after.title,/\n/);
  assert.equal(after.displayedHeart.value,140);
  assert.equal(after.features.heart.current,75);
  assert.equal(after.timeMeaning,"latest_displayed_measurement");
 });

 test('pressure and sleep have independent states and preserve boundary scores', () => {
  for (const [score,color,emoji,state] of [[0,'🟢','😌','relaxed'],[25,'🟢','😌','relaxed'],[26,'🔵','🙂','balanced'],[60,'🔵','🙂','balanced'],[61,'🟡','😮‍💨','elevated'],[80,'🟡','😮‍💨','elevated'],[81,'🔴','😵‍💫','high'],[100,'🔴','😵‍💫','high']]) {
   assert.deepEqual(scorePresentation('pressure',score),{color,emoji,state});
  }
  for (const [score,emoji,state] of [[0,'🛌','rest_needed'],[39,'🛌','rest_needed'],[40,'🥱','fair'],[59,'🥱','fair'],[60,'🙂','good'],[79,'🙂','good'],[80,'😴','excellent'],[100,'😴','excellent']]) {
   assert.equal(scorePresentation('sleep',score).emoji,emoji);
   assert.equal(scorePresentation('sleep',score).state,state);
  }
  for(const type of ['sleep','pressure']) assert.deepEqual(scorePresentation(type,null),{color:'⚪',emoji:'⚪',state:'unavailable'});
 });
 test('published decision includes both state mappings without changing numeric scores', () => {
  const r=evaluateHealthIndices(fixture(),T+60000);
  assert.equal(r.pressure.presentation.state,'high');
  assert.equal(r.sleep.presentation.state,'excellent');
  assert.match(r.title,/^🔴 压力过载 😴 睡眠99｜/);
 });


test('pressure trend compares published samples and survives duplicate refresh and late HR', () => {
 const s=fixture(), first=evaluateHealthIndices(s,T+60000);
 assert.equal(first.pressure.trend.arrow,'');
 s.hrv.push({...s.hrv[0],start:T+H,value:60});
 s.heart.push({...s.heart[0],start:T+H,end:T+H+60000,value:60});
 const next=evaluateHealthIndices(s,T+H+60000,first);
 assert.equal(next.pressure.trend.arrow,'↓');
 assert.match(next.title,/^🔵 状态正常 /); assert.match(next.title,/HRV60 /);
 const repeat=evaluateHealthIndices(s,T+2*H,next);
 assert.equal(repeat.pressure.score,next.pressure.score);
 assert.equal(repeat.asOfAt,next.asOfAt);
 assert.match(repeat.title,/状态正常/);
 s.heart.at(-1).value=65;
 const revised=evaluateHealthIndices(s,T+2*H,next);
 assert.equal(revised.pressure.trend.reference.score,first.pressure.score);
 assert.equal(revised.pressure.trend.delta,revised.pressure.score-first.pressure.score);
 const invalid=evaluateHealthIndices(s,T+7*H,next);
 assert.equal(invalid.pressure.trend.arrow,'');
 assert.equal(invalid.pressure.trend.lastValid.score,next.pressure.score);
});
test('pressure trend omits noncomparable references and shows rises only for higher scores', () => {
 const s=fixture(); s.hrv[0].value=60;s.heart[0].value=60;
 const first=evaluateHealthIndices(s,T+60000);
 s.hrv.push({...s.hrv[0],start:T+H,value:30});
 s.heart.push({...s.heart[0],start:T+H,end:T+H+60000,value:75});
 assert.equal(evaluateHealthIndices(s,T+H+60000,first).pressure.trend.arrow,'↑');
 for(const mutate of [p=>p.ruleVersion='old',p=>p.pressure.trend.lastValid.source='Other',
   p=>p.pressure.trend.lastValid.at=T-2*D,p=>p.pressure.trend.lastValid.at=T+2*H]) {
  const p=structuredClone(first);mutate(p);
  assert.equal(evaluateHealthIndices(s,T+H+60000,p).pressure.trend.arrow,'');
 }
});


test('display clock follows measurement rather than upload, excludes future and conflicting HR', () => {
 const s=fixture();
 s.heart.push({start:T+H,end:T+H+60000,value:65,source:'Watch'});
 const r=evaluateHealthIndices(s,T+2*H);
 assert.equal(r.displayedHeart.measuredAt,T+H);
 assert.equal(r.displayedHeart.method,'latest_minute_window');
 const expiredDisplay=evaluateHealthIndices(s,T+3*H);
 assert.equal(expiredDisplay.displayedHeart.value,65);
 assert.equal(expiredDisplay.pressure.score,r.pressure.score);
 assert.match(expiredDisplay.title,/心率65｜09\/28 16:00｜详情 ↗$/);
 s.heart.push({start:T+4*H,end:T+4*H+60000,value:90,source:'Watch'});
 assert.equal(evaluateHealthIndices(s,T+2*H).title,r.title);
 s.heart.push({start:T+H,end:T+H+60000,value:66,source:'Watch'});
 const conflict=evaluateHealthIndices(s,T+2*H);
 assert.equal(conflict.displayedHeart,null);
 assert.equal(conflict.asOfAt,T);
 assert.doesNotMatch(conflict.title,/HR\d|HR—/);
});
test('heart display works without HRV and never fabricates a pressure score', () => {
 const s=fixture();s.hrv=[];
 const r=evaluateHealthIndices(s,T+60000);
 assert.equal(r.asOfAt,T);assert.equal(r.displayedHeart.value,75);
 assert.equal(r.pressure.score,null);assert.equal(r.scoreAt,null);
});

function nightlyFixture() {
 const s = { hrv: [], heart: [], sleep: [], daily: [], workout: [] };
 const end = T - 7 * H;
 for (let d = 0; d <= 4; d++) {
  const finish = end - d * D, start = finish - 8 * H;
  s.sleep.push({ start, end: finish, stage: 'core', source: 'Watch' });
  for (const [offset, value] of [[2, 20], [6, 100]])
   s.hrv.push({ start: start + offset * H, value, method: 'SDNN', source: 'Watch' });
  for (let i = 1; i <= 7; i++)
   s.heart.push({ start: start + i * H, end: start + i * H + 60000, value: 60, source: 'Watch' });
 }
 return { s, end, now: end + 2 * H };
}
test('nightly pressure uses per-night HRV and HR baselines rather than discarding sleeping observations', () => {
 const { s, end, now } = nightlyFixture();
 const r = evaluateHealthIndices(s, now);
 assert.equal(r.pressure.score, 50);
 assert.equal(r.pressure.context, 'nightly');
 assert.equal(r.pressure.evidence.hrv, 60); // median of 20 and 100, not latest 100
 assert.equal(r.pressure.evidence.heart, 60);
 assert.equal(r.pressure.hrvBaseline.days, 4);
 assert.equal(r.pressure.heartBaseline.days, 4);
 assert.equal(r.scoreAt, end);
 assert.match(r.title, /🔵 昨夜状态正常/);
 assert.equal(r.features.hrv.current, 100); // public raw HRV remains the latest sample
 assert.equal(r.pressure.primaryReason, 'sleep_or_workout');
 assert.equal(r.pressure.reason, null);
});
test('new display HR cannot change a nightly score; completed-night evidence outlives a single HRV point', () => {
 const { s, end, now } = nightlyFixture(), first = evaluateHealthIndices(s, now);
 s.heart.push({ start: now, end: now + 60000, value: 110, source: 'Watch' });
 const next = evaluateHealthIndices(s, now + 60000, first);
 assert.equal(next.pressure.score, first.pressure.score);
 assert.equal(next.displayedHeart.value, 110);
 assert.equal(next.asOfAt, now);
 assert.equal(evaluateHealthIndices(s, end + 12 * H).pressure.score, 50);
 assert.equal(evaluateHealthIndices(s, end + 36 * H).pressure.score, null);
});
test('nightly fallback requires three comparable nights and rejects conflicts, unknown sources and workouts', () => {
 const { s, end, now } = nightlyFixture();
 const sparse = structuredClone(s); sparse.sleep = sparse.sleep.slice(0, 3);
 assert.equal(evaluateHealthIndices(sparse, now).pressure.score, null);
 const conflict = structuredClone(s); conflict.sleep.push({ ...s.sleep[0], stage: 'deep' });
 assert.equal(evaluateHealthIndices(conflict, now).pressure.score, null);
 const unknown = structuredClone(s); unknown.hrv.forEach(r => r.source = 'unknown');
 assert.equal(evaluateHealthIndices(unknown, now).pressure.score, null);
 const exercise = structuredClone(s); exercise.workout.push({ start: end - 8 * H, end });
 assert.equal(evaluateHealthIndices(exercise, now).pressure.score, null);
 assert.equal(evaluateHealthIndices(s, end + 30 * 60000).pressure.score, null);
});
test('awake scoring takes priority and never compares its trend with a nightly score', () => {
 const { s, now } = nightlyFixture();
 const night = evaluateHealthIndices(s, now);
 const awake = fixture();
 for (const key of ['hrv', 'heart']) s[key].push(...awake[key]);
 const r = evaluateHealthIndices(s, T + 60000, night);
 assert.equal(r.pressure.context, 'awake_sample');
 assert.equal(r.pressure.score, 95);
 assert.equal(r.pressure.trend.arrow, '');
 assert.doesNotMatch(r.title, /（夜间）/);
});
test('nightly pressure responds to deviations rather than filling a fixed neutral score', () => {
 const { s, end, now } = nightlyFixture();
 const lower = structuredClone(s), higher = structuredClone(s);
 for (const r of lower.hrv.filter(r => r.start > end - 8 * H)) r.value *= 1.5;
 for (const r of lower.heart.filter(r => r.start > end - 8 * H)) r.value -= 5;
 for (const r of higher.hrv.filter(r => r.start > end - 8 * H)) r.value *= 0.5;
 for (const r of higher.heart.filter(r => r.start > end - 8 * H)) r.value += 10;
 assert.ok(evaluateHealthIndices(lower, now).pressure.score < 50);
 assert.ok(evaluateHealthIndices(higher, now).pressure.score > 50);
});
test('nightly evidence validity distinguishes corrections from expiry even when awake scoring wins', () => {
 const { s, end, now } = nightlyFixture();
 assert.equal(evaluateHealthIndices(s, now).nightlyEvidence.status, 'available');
 s.sleep.push({ ...s.sleep[0], stage: 'deep' });
 assert.deepEqual(evaluateHealthIndices(s, now).nightlyEvidence, { evidenceAt: end, status: 'unavailable' });
 assert.equal(evaluateHealthIndices(s, end + 37 * H).nightlyEvidence.status, 'expired');
});

test('a different daytime HRV device cannot revoke an unchanged completed night', () => {
 const { s, end, now } = nightlyFixture();
 s.hrv.push({ start: now - 60000, end: now - 60000, value: 70, method: 'SDNN', source: 'Phone' });
 assert.deepEqual(evaluateHealthIndices(s, now).nightlyEvidence, { evidenceAt: end, status: 'available' });
});

test('compact signature retains pressure, sleep and available measurements', () => {
 const r = evaluateHealthIndices(fixture(), T + 60000);
 assert.match(r.title, /压力过载/);
 assert.match(r.title, /睡眠99/);
 assert.match(r.title, /HRV30 心率75/);
});

test('a valid daily aggregate remains visible when the latest sample is excluded by a workout', () => {
 const s = fixture(); s.workout.push({ start: T - 60000, end: T });
 const history = { days: [{ date: '2026-09-28', status: 'available', ruleVersion: 'health-indices-v3-nightly',
   median: 45, count: 5, spanMinutes: 240 }] };
 const r = evaluateHealthIndices(s, T + 60000, null, { pressureHistory: history });
 assert.equal(r.pressure.score, null);
 assert.match(r.title, /^🔵 状态正常/);
});

test('a source-less recent heart value can display without being assigned to an HRV scoring pair', () => {
 const s = fixture();
 s.heart.push({ start: T + 30 * 60000, end: T + 31 * 60000, value: 68, source: 'unknown' });
 const r = evaluateHealthIndices(s, T + 31 * 60000);
 assert.equal(r.displayedHeart.value, 68);
 assert.equal(r.displayedHeart.source, 'unknown');
 assert.equal(r.pressure.evidence.heart, 75);
 assert.match(r.title, /心率68/);
});

test('old estimates and expired display heart are not presented as current measurements', () => {
 const r = evaluateHealthIndices(fixture(), T + 2 * H);
 assert.match(r.title, /压力过载/);
 assert.match(r.title, /心率75｜09\/28 15:00｜详情 ↗$/);
 assert.doesNotMatch(r.title, /当前压力/);
});

test('the scheduled 45-minute recheck retains the original four-tier heading', () => {
 const current = evaluateHealthIndices(fixture(), T + 44 * 60000);
 assert.match(current.title, /压力过载/);
 assert.equal(current.validUntil, T + 45 * 60000);
 assert.match(evaluateHealthIndices(fixture(), current.validUntil).title, /压力过载/);
});

test('wrong-rule or insufficient daily history cannot conceal a missing scoring pair', () => {
 const s = fixture(); s.heart = [];
 for (const day of [
  { date: '2026-09-28', status: 'available', ruleVersion: 'old', median: 45 },
  { date: '2026-09-28', status: 'insufficient_samples', ruleVersion: 'health-indices-v3-nightly', median: null },
 ]) {
  const r = evaluateHealthIndices(s, T + 60000, null, { pressureHistory: { days: [day] } });
  assert.equal(r.pressure.reason, 'missing_or_conflicting_aligned_hr');
  assert.match(r.title, /压力暂无/); assert.doesNotMatch(r.title, /待评估|待确认/);
  assert.doesNotMatch(r.title, /状态正常/);
 }
});

function rmssdFixture() {
 const s = fixture();
 for (let d = 0; d <= 8; d++) {
  for (let i = 0; i < 3; i++) {
   const start = T - d * D - (2 - i) * 5 * 60000;
   s.hrv.push({ start, end: start + 60000, value: d ? 40 : [20, 40, 120][i],
    method: 'RMSSD', source: 'Watch', aggregation: 'minutes' });
  }
  for (let i = 0; i < 20; i++) {
   const start = T - d * D - i * 60000;
   s.heart.push({ start, end: start + 60000, value: 60, source: 'Watch' });
  }
 }
 // The original fixture's current HR is 75; the minute export corrects that same window.
 s.heart = s.heart.filter(r => r.start !== T || r.value === 60);
 return s;
}
test('RMSSD pressure uses a trailing median and its own baseline, not SDNN or one outlier', () => {
 const s = rmssdFixture(), r = evaluateHealthIndices(s, T + 60000);
 assert.equal(r.ruleVersion, 'health-indices-v5-rmssd-warmup');
 assert.equal(r.features.hrv.method, 'RMSSD');
 assert.equal(r.features.hrv.current, 120);
 assert.equal(r.pressure.hrvMethod, 'RMSSD');
 assert.equal(r.pressure.evidence.hrv, 40);
 assert.equal(r.pressure.evidence.hrvSamples, 3);
 assert.equal(r.pressure.evidence.hrvSpanMinutes, 10);
 assert.equal(r.pressure.hrvBaseline.median, 40);
 assert.equal(r.pressure.hrvBaseline.days, 8);
 assert.equal(r.pressure.score, 50);
 assert.match(r.title, /恢复HRV120/);
 s.hrv.filter(r => r.method === 'SDNN').forEach(r => r.value = 999);
 assert.deepEqual(evaluateHealthIndices(s, T + 60000).pressure, r.pressure);
});
test('RMSSD baseline counts comparable prior days, excluding other methods, devices and current day', () => {
 const s = rmssdFixture();
 s.hrv = s.hrv.filter(r => r.method !== 'RMSSD' || r.start >= T - 6 * D - 15 * 60000);
 const r = evaluateHealthIndices(s, T + 60000);
 assert.equal(r.pressure.hrvBaseline.days, 6);
 assert.equal(r.pressure.score, 50);
 assert.equal(r.pressure.reason, null);
 assert.equal(r.pressure.confidence, 'short_baseline');
 const first = rmssdFixture(); first.hrv.filter(r => r.method === 'RMSSD' && r.start < T - 15 * 60000).forEach(r => r.source = 'Old Watch');
 assert.equal(evaluateHealthIndices(first, T + 60000).pressure.hrvBaseline.days, 0);
 const thin = rmssdFixture(); thin.hrv = thin.hrv.filter(r => r.method !== 'RMSSD' || r.start >= T - 10 * 60000 || (T - r.start) % D === 0);
 assert.equal(evaluateHealthIndices(thin, T + 60000).pressure.hrvBaseline.days, 0, 'one point per day is not a comparable RMSSD day');
});

test('one comparable RMSSD and heart day permits a provisional score without using the current day as baseline', () => {
 const s = rmssdFixture(), since = T - D - 15 * 60000;
 s.hrv = s.hrv.filter(r => r.method !== 'RMSSD' || r.start >= since);
 s.heart = s.heart.filter(r => r.start >= since);
 const r = evaluateHealthIndices(s, T + 60000);
 assert.equal(r.pressure.hrvBaseline.days, 1);
 assert.equal(r.pressure.heartBaseline.days, 1);
 assert.equal(r.pressure.score, 50);
 assert.equal(r.pressure.reason, null);
 assert.equal(r.pressure.confidence, 'short_baseline');
 assert.match(r.title, /状态正常/);
 assert.doesNotMatch(r.title, /压力积累中|待更新|初估|·|@/);
 assert.equal(r.title.match(/\d{2}\/\d{2} \d{2}:\d{2}/g)?.length, 1);
 for (const kind of ['hrv', 'heart']) {
  const missing = structuredClone(s);
  missing[kind] = missing[kind].filter(row => row.start >= T - 20 * 60000);
  const result = evaluateHealthIndices(missing, T + 60000);
  assert.equal(result.pressure.score, null);
  assert.equal(result.pressure.reason, 'short_baseline');
 }
 const sparse = structuredClone(s);
 sparse.hrv = sparse.hrv.filter(row => row.start < T - 20 * 60000 || row.method !== 'RMSSD' || row.start === T);
 assert.equal(evaluateHealthIndices(sparse, T + 60000).pressure.reason, 'insufficient_samples');
 assert.equal(evaluateHealthIndices(s, T + 90 * 60000).pressure.reason, 'expired_hrv');
});

test('RMSSD scores retain the same formula as more baseline days accumulate and remove the provisional label', () => {
 const s = rmssdFixture();
 for (let d = 9; d <= 14; d++) {
  for (let i = 0; i < 3; i++) {
   const start = T - d * D - i * 5 * 60000;
   s.hrv.push({ start, end: start + 60000, value: 40, method: 'RMSSD', source: 'Watch', aggregation: 'minutes' });
  }
 }
 const r = evaluateHealthIndices(s, T + 60000);
 assert.equal(r.pressure.hrvBaseline.days, 14);
 assert.equal(r.pressure.score, 50);
 assert.equal(r.pressure.confidence, 'personal_baseline');
 assert.match(r.title, /状态正常/);
 assert.doesNotMatch(r.title, /初估/);
 s.heart = s.heart.filter(row => row.start >= T - D - 15 * 60000);
 const shortHeart = evaluateHealthIndices(s, T + 60000);
 assert.equal(shortHeart.pressure.score, 50);
 assert.equal(shortHeart.pressure.confidence, 'short_baseline');
 assert.match(shortHeart.title, /状态正常/);
});

test('short-baseline RMSSD daily summaries keep confidence metadata and compact public wording', () => {
 const r = evaluateHealthIndices(rmssdFixture(), T + 60000);
 r.pressure.confidence = 'personal_baseline';
 const history = { days: [{ date: '2026-09-28', status: 'available', ruleVersion: r.ruleVersion,
  median: 50, confidence: 'short_baseline' }] };
 assert.match(renderHealthSignature(r, T + 60000, history), /^🔵 状态正常/);
 assert.doesNotMatch(renderHealthSignature(r, T + 60000, history), /初估/);
 assert.equal(history.days[0].confidence, 'short_baseline');
});
test('RMSSD requires distributed recent evidence; repeats and exercise cannot supply coverage', () => {
 for (const mutate of [
  s => { s.hrv = s.hrv.filter(r => r.method !== 'RMSSD' || r.start !== T - 10 * 60000); },
  s => { s.hrv.filter(r => r.method === 'RMSSD' && r.start >= T - 10 * 60000).forEach((r, i) => { r.start = T - i * 60000; r.end = r.start + 60000; }); },
  s => { s.heart = s.heart.filter(r => r.start < T - 20 * 60000 || r.start >= T - 2 * 60000); },
 ]) {
  const s = rmssdFixture(); mutate(s);
  assert.equal(evaluateHealthIndices(s, T + 60000).pressure.score, null);
 }
 const s = rmssdFixture(), before = evaluateHealthIndices(s, T + 60000);
 s.hrv.push(...s.hrv.map(r => ({ ...r }))); s.heart.push(...s.heart.map(r => ({ ...r })));
 assert.deepEqual(evaluateHealthIndices(s, T + 60000).pressure, before.pressure);
 s.workout.push({ start: T - 60000, end: T + 60000 });
 assert.equal(evaluateHealthIndices(s, T + 60000).pressure.reason, 'sleep_or_workout');
});
test('stale, unknown or conflicting RMSSD never falls back to a valid SDNN score', () => {
 const s = rmssdFixture();
 assert.equal(evaluateHealthIndices(s, T + 90 * 60000).pressure.reason, 'expired_hrv');
 assert.match(evaluateHealthIndices(s, T + 90 * 60000).title, /恢复HRV120 心率60｜09\/28 15:00｜详情 ↗$/);
 assert.doesNotMatch(evaluateHealthIndices(s, T + 90 * 60000).title, /待更新|待评估|—/);
 for (const mutate of [
  a => { a.hrv.find(r => r.method === 'RMSSD' && r.start === T).source = 'unknown'; },
  a => { a.hrv.push({ ...a.hrv.find(r => r.method === 'RMSSD' && r.start === T), value: 10 }); },
 ]) {
  const a = rmssdFixture(); mutate(a);
  const r = evaluateHealthIndices(a, T + 60000);
  assert.equal(r.pressure.score, null); assert.equal(r.pressure.reason, 'source_or_sample_conflict');
  assert.equal(r.features.hrv.method, 'RMSSD');
 }
 const r = evaluateHealthIndices(s, T + 60000);
 assert.equal(r.pressure.validUntil, T + 90 * 60000);
 assert.equal(r.validUntil, T + 45 * 60000, 'signature presentation refreshes before numeric expiry');
 const removed = { ...s, hrv: s.hrv.filter(r => r.method === 'SDNN') };
 assert.equal(evaluateHealthIndices(removed, T + 60000, r).features.hrv.method, 'RMSSD');
});
test('RMSSD trend cannot compare scores across HRV methods', () => {
 const old = fixture(); old.hrv[0].start = T - H; old.heart[0].start = T - H; old.heart[0].end = T - H + 60000;
 const previous = evaluateHealthIndices(old, T - H + 60000);
 const r = evaluateHealthIndices(rmssdFixture(), T + 60000, previous);
 assert.equal(r.pressure.trend.arrow, '');
 assert.equal(r.pressure.trend.reference, null);
});
test('nightly RMSSD needs independent nights and actual coverage for both signals', () => {
 const s = { hrv: [], heart: [], sleep: [], daily: [], workout: [] }, end = T - 7 * H;
 for (let d = 0; d <= 8; d++) {
  const finish = end - d * D, start = finish - 8 * H;
  s.sleep.push({ start, end: finish, stage: 'core', source: 'Watch' });
  for (let i = 0; i < 96; i++) s.hrv.push({ start: start + i * 5 * 60000, end: start + i * 5 * 60000 + 60000,
   value: 40, method: 'RMSSD', source: 'Watch', aggregation: 'minutes' });
  // Production keeps seven days of HR in the scoring read; RMSSD history is longer.
  if (d <= 5) for (let i = 0; i < 480; i++) s.heart.push({ start: start + i * 60000, end: start + (i + 1) * 60000, value: 60, source: 'Watch' });
 }
 const r = evaluateHealthIndices(s, end + 2 * H);
 assert.equal(r.pressure.score, 50); assert.equal(r.pressure.context, 'nightly');
 assert.equal(r.pressure.hrvMethod, 'RMSSD'); assert.equal(r.pressure.hrvBaseline.days, 8);
 assert.equal(r.pressure.heartBaseline.days, 5);
 s.hrv.reverse(); s.heart.reverse();
 assert.equal(evaluateHealthIndices(s, end + 2 * H).pressure.score, 50);
 const sparse = structuredClone(s); sparse.hrv = sparse.hrv.filter(x => x.start < end - 8 * H || x.start >= end - H);
 assert.equal(evaluateHealthIndices(sparse, end + 2 * H).pressure.score, null);
 const sparseHeart = structuredClone(s); sparseHeart.heart = sparseHeart.heart.filter(x => x.start < end - 8 * H || x.start >= end - H);
 assert.equal(evaluateHealthIndices(sparseHeart, end + 2 * H).pressure.score, null);
});


test('a new RMSSD baseline retains context and one clock through sparse or stale evidence', () => {
 const s = rmssdFixture();
 s.hrv = s.hrv.filter(r => r.method !== 'RMSSD' || r.start >= T - 15 * 60000);
 const sparse = structuredClone(s);
 sparse.hrv = sparse.hrv.filter(r => r.method !== 'RMSSD' || r.start === T);
 const sparseResult = evaluateHealthIndices(sparse, T + 60000);
 assert.equal(sparseResult.pressure.score, null);
 assert.equal(sparseResult.pressure.reason, 'insufficient_samples');
 assert.match(sparseResult.title, /压力积累中/);
 assert.doesNotMatch(sparseResult.title, /压力暂无|RMSSD/);
 const mature = rmssdFixture();
 mature.hrv = mature.hrv.filter(r => r.method !== 'RMSSD' || r.start < T - 20 * 60000 || r.start === T);
 const matureResult = evaluateHealthIndices(mature, T + 60000);
 assert.equal(matureResult.pressure.reason, 'insufficient_samples');
 assert.equal(matureResult.pressure.hrvBaseline.days, 8);
 assert.match(matureResult.title, /压力暂无/);
 s.heart.push({ start: T + 5 * H, end: T + 5 * H + 60000, value: 55, source: 'Watch' });
 const now = T + 7 * H, r = evaluateHealthIndices(s, now);
 assert.equal(r.pressure.score, null);
 assert.equal(r.pressure.reason, 'expired_hrv');
 assert.equal(r.pressure.hrvBaseline.days, 0);
 assert.equal(r.asOfAt, T + 5 * H);
 assert.match(r.title, /压力积累中/);
 assert.match(r.title, /恢复HRV120 心率55｜09\/28 20:00｜详情 ↗$/);
 assert.doesNotMatch(r.title, /待更新|待评估|—|HRV30|@|·/);
 assert.equal(r.title.match(/\d{2}\/\d{2} \d{2}:\d{2}/g)?.length, 1);
 // A repeated upload cannot refresh either the evidence or measurement labels.
 assert.equal(evaluateHealthIndices(s, now + 60000, r).title, r.title);
 const nextDay = evaluateHealthIndices(s, T + 10 * H);
 assert.match(nextDay.title, /恢复HRV120 心率55｜09\/28 20:00｜详情 ↗$/);
});


test('signature sleep uses today in Beijing while yesterday remains a dated dashboard score', () => {
 const now = T + D;
 const r = evaluateHealthIndices(fixture(), now);
 assert.equal(r.sleep.date, '2026-09-28');
 assert.equal(r.sleep.score, 99, 'historical score stays available within its existing validity');
 assert.match(r.title, /睡眠 - /);
 assert.doesNotMatch(r.title, /睡眠99/);
 assert.match(r.title, /HRV30 心率75/);
});

test('sleep signature changes at Beijing midnight even before the old score expires', () => {
 const r = evaluateHealthIndices(fixture(), T + 60000);
 const midnight = Date.parse('2026-09-29T00:00:00+08:00');
 assert.match(renderHealthSignature(r, midnight - 1), /睡眠99/);
 assert.match(renderHealthSignature(r, midnight), /睡眠 - /);
 for (const sleep of [ { ...r.sleep, date: '2026-09-29' },
   { ...r.sleep, date: undefined }, { ...r.sleep, score: null },
   { ...r.sleep, reason: 'sleep_settling', score: null } ]) {
  assert.match(renderHealthSignature({ ...r, sleep }, T + 60000), /睡眠 - /);
 }
});

test('missing sleep shows a dash and completed sleep is dated by its Beijing wake day', () => {
 const s = fixture(); s.sleep = [];
 assert.match(evaluateHealthIndices(s, T + 60000).title, /睡眠 - /);
 const overnight = fixture(); overnight.sleep[0].start -= H;
 const r = evaluateHealthIndices(overnight, T + 60000);
 assert.equal(r.sleep.date, '2026-09-28');
 assert.match(r.title, /睡眠85/);
 const zero = { ...r, sleep: { ...r.sleep, score: 0, presentation: scorePresentation('sleep', 0) } };
 assert.match(renderHealthSignature(zero, T + 60000), /睡眠0/);
});
