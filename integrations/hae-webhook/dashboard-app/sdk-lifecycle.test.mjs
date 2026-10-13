import test from 'node:test';
import assert from 'node:assert/strict';
import { createDashboardClient } from './src/client.mjs';

const config = { base: 'base-test', table: 'table-test', record: 'record-test', initCode: 'test-init' };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const payload = (range, marker) => JSON.stringify({ schemaVersion: 'dashboard-v1', range, marker, metrics: { heart: { value: 70 } } });
const response = (marker, fields = {}) => ({ code: 0, data: { records: [{ fields: { payload_24h: payload('24h', marker), payload_7d: payload('7d', `${marker}-7d`), ...fields } }] } });
const sdk = read => ({ init: async () => ({ code: 0 }), base_records_get: read });

test('an expired runtime session renews a configured initialization once within the same load', async t => {
  let inits = 0, reads = 0;
  const h = harness(t, {
    init: async () => { inits++; return { code: 0 }; },
    base_records_get: async () => ++reads === 1 ? { code: 401, msg: 'Invalid runtime session' } : response('renewed'),
  });
  await h.client.load();
  assert.equal(h.snapshot().data?.marker, 'renewed');
  assert.equal(inits, 2);
  assert.equal(reads, 2);
});

test('persistent runtime expiry stops after one renewal and clears both cached windows', async t => {
  let expired = false, reads = 0;
  const h = harness(t, sdk(async () => { reads++; return expired ? { code: 401, msg: 'Invalid runtime session' } : response('private'); }));
  await h.client.load();
  expired = true; await h.client.load(false);
  assert.equal(reads, 3);
  assert.equal(h.snapshot().data, null);
  assert.equal(h.snapshot().weeklyData, null);
  assert.equal(h.snapshot().error.code, 'session_expired');
});

test('runtime expiry clears cached data even when the SDK throws an error without a numeric code', async t => {
  let expired = false, reads = 0;
  const h = harness(t, sdk(async () => {
    reads++; if (expired) throw new Error('401 Invalid runtime session'); return response('reader');
  }));
  await h.client.load(); expired = true; await h.client.load(false);
  assert.equal(reads, 3);
  assert.equal(h.snapshot().data, null);
  assert.equal(h.snapshot().weeklyData, null);
  assert.equal(h.snapshot().error.code, 'session_expired');
});

test('runtime renewal shares the original deadline and cannot read after timing out', async t => {
  const renewal = deferred(), read = deferred(); let inits = 0, reads = 0;
  const h = harness(t, {
    init: () => ++inits === 1 ? Promise.resolve({ code: 0 }) : renewal.promise,
    base_records_get: () => { reads++; return read.promise; },
  });
  const loading = h.client.load(); await h.advance(14000);
  read.resolve({ code: 401, msg: 'Invalid runtime session' }); await flush();
  assert.equal(inits, 2);
  await h.advance(1000); await loading;
  assert.equal(h.snapshot().error.code, 'timeout');
  renewal.resolve({ code: 0 }); await flush();
  assert.equal(reads, 1);
});

test('unchanged background reads preserve the snapshot and do not notify subscribers', async t => {
  const h = harness(t, sdk(async () => response('same')));
  await h.client.load();
  const before = h.snapshot();
  let notifications = 0;
  h.client.subscribe(() => notifications++);
  await h.client.load(false);
  assert.equal(h.snapshot(), before);
  assert.equal(notifications, 0);
  h.client.setRange('7d');
  const week = h.snapshot().data;
  h.client.setRange('24h');
  assert.equal(h.snapshot().data, before.data);
  h.client.setRange('7d');
  assert.equal(h.snapshot().data, week);
});

test('same content hash cannot hide newer evaluation times or corrected samples', async t => {
  let dto = { schemaVersion: 'dashboard-v1', range: '24h', contentHash: 'same', generatedAt: 1000, metrics: { heart: { value: 70 } } };
  const h = harness(t, sdk(async () => response('same', { payload_24h: JSON.stringify(dto) })));
  await h.client.load();
  const before = h.snapshot().data;
  dto = { ...dto, generatedAt: 2000 };
  await h.client.load(false);
  assert.notEqual(h.snapshot().data, before);
  assert.equal(h.snapshot().data.generatedAt, 2000);
  dto = { ...dto, metrics: { heart: { value: 80 } } };
  await h.client.load(false);
  assert.equal(h.snapshot().data.metrics.heart.value, 80);
});

test('permission loss discards parsed payloads before an identical authorized recovery', async t => {
  let denied = false;
  const h = harness(t, sdk(async () => denied ? { code: 403 } : response('same')));
  await h.client.load();
  const before = h.snapshot().data;
  denied = true; await h.client.load(false);
  assert.equal(h.snapshot().data, null);
  assert.equal(h.snapshot().weeklyData, null);
  denied = false; await h.client.load(false);
  assert.deepEqual(h.snapshot().data, before);
  assert.notEqual(h.snapshot().data, before);
  assert.equal(h.snapshot().stale, false);
});

test('unchanged payload recovery clears a transient error and notifies subscribers', async t => {
  let failed = false;
  const h = harness(t, sdk(async () => { if (failed) throw new Error('offline'); return response('same'); }));
  await h.client.load();
  const before = h.snapshot().data;
  failed = true; await h.client.load(false);
  let notifications = 0;
  h.client.subscribe(() => notifications++);
  failed = false; await h.client.load(false);
  assert.equal(h.snapshot().data, before);
  assert.equal(h.snapshot().error, null);
  assert.equal(h.snapshot().stale, false);
  assert.equal(notifications, 1);
});

// Only the SDK boundary and the clock are fake; assertions exercise the real reader.
function harness(t, magic, options = {}) {
  const timers = new Map(); let now = 0, sequence = 0;
  const schedule = (fn, ms, repeat) => {
    const id = ++sequence;
    timers.set(id, { fn, at: now + ms, ms, repeat });
    return id;
  };
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => schedule(fn, ms, false));
  t.mock.method(globalThis, 'setInterval', (fn, ms) => schedule(fn, ms, true));
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  t.mock.method(globalThis, 'clearInterval', id => timers.delete(id));
  const state = { magic, visible: true };
  const client = createDashboardClient({ config, getMagic: () => state.magic, isVisible: () => state.visible, ...options });
  t.after(() => client.stop());
  const advance = async ms => {
    const target = now + ms;
    await flush();
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next; now = timer.at;
      if (timer.repeat) timer.at += timer.ms; else timers.delete(id);
      timer.fn(); await flush();
    }
    now = target; await flush();
  };
  return { client, state, timers, advance, snapshot: () => client.getSnapshot() };
}

test('snapshot is stable, immutable, and subscriptions only report updates', async t => {
  const h = harness(t, sdk(async () => response('first')));
  const initial = h.snapshot();
  assert.deepEqual(initial, { range: '24h', data: null, weeklyData: null, weeklyError: null, loading: false, error: null, stale: false });
  assert.equal(h.snapshot(), initial);
  assert.ok(Object.isFrozen(initial));
  const changes = [];
  const unsubscribe = h.client.subscribe(() => changes.push(h.snapshot()));
  h.client.setRange('24h'); assert.equal(changes.length, 0);
  await h.client.load();
  assert.equal(changes.length, 2);
  assert.equal(changes[0].loading, true);
  assert.equal(changes[1].data.marker, 'first');
  assert.ok(Object.isFrozen(changes[1].data.metrics.heart));
  assert.throws(() => { changes[1].data.metrics.heart.value = 100; }, TypeError);
  unsubscribe(); h.client.setRange('7d'); assert.equal(changes.length, 2);
});

test('init deadline releases load and polling exists before init resolves', async t => {
  let reads = 0; const init = deferred();
  const h = harness(t, { init: () => init.promise, base_records_get: async () => { reads++; return response('late'); } });
  const first = h.client.start(); await flush();
  assert.ok([...h.timers.values()].some(timer => timer.repeat && timer.ms === 120000));
  await h.advance(15000); await first;
  assert.equal(h.snapshot().loading, false);
  assert.equal(h.snapshot().error.code, 'timeout');
  init.resolve({ code: 0 }); await flush();
  assert.equal(reads, 0, 'expired initialization must not launch a late read');
  h.state.magic = sdk(async () => response('recovered'));
  await h.client.load(); assert.equal(h.snapshot().data.marker, 'recovered');
});

test('hanging read times out, recovers, and ignores the late result', async t => {
  const pending = deferred(); let reads = 0;
  const h = harness(t, sdk(() => ++reads === 1 ? pending.promise : Promise.resolve(response('recovered'))));
  const first = h.client.load(); await flush(); await h.advance(15000); await first;
  assert.equal(h.snapshot().error.code, 'timeout');
  await h.client.load(); const recovered = h.snapshot();
  assert.equal(recovered.data.marker, 'recovered');
  pending.resolve(response('late')); await flush(); assert.equal(h.snapshot(), recovered);
});

test('permission rejection clears data and cached fields and resets initialization', async t => {
  let denied = false, inits = 0;
  const h = harness(t, { init: async () => { inits++; }, base_records_get: async () => denied ? { code: 403 } : response('private') });
  await h.client.load(); denied = true; await h.client.load(false);
  assert.equal(h.snapshot().data, null);
  assert.equal(h.snapshot().error.code, 'permission_denied');
  h.client.setRange('7d');
  assert.equal(h.snapshot().data, null, 'cached private fields must not be rendered');
  await h.client.load(); assert.equal(inits, 2);
});

test('transient transport errors retain data and range changes keep the cache warning', async t => {
  let failed = false;
  const h = harness(t, sdk(async () => { if (failed) throw new Error('network unavailable'); return response('private'); }));
  await h.client.load(); failed = true; await h.client.load(false);
  const error = h.snapshot().error;
  assert.equal(h.snapshot().data.marker, 'private');
  assert.equal(error.message, 'network unavailable');
  h.client.setRange('7d');
  assert.equal(h.snapshot().data.marker, 'private-7d');
  assert.equal(h.snapshot().error, error);
  assert.equal(h.snapshot().stale, true);
});

test('missing SDK has the same deadline and can recover after injection', async t => {
  const h = harness(t, undefined);
  const first = h.client.load(); await h.advance(15000); await first;
  assert.equal(h.snapshot().error.code, 'timeout');
  h.state.magic = sdk(async () => response('injected'));
  await h.client.load(); assert.equal(h.snapshot().data.marker, 'injected');
});

test('an authorization denial returned by init never proceeds to read private records', async t => {
  let reads = 0;
  const h = harness(t, { init: async () => ({ code: 403 }), base_records_get: async () => { reads++; return response('private'); } });
  await h.client.load();
  assert.equal(reads, 0); assert.equal(h.snapshot().data, null);
  assert.equal(h.snapshot().error.code, 'permission_denied');
});

for (const code of [429, 500, 99999999]) {
  test(`transient Base API code ${code} retains data and cache warning`, async t => {
    let failed = false;
    const h = harness(t, sdk(async () => failed ? { code } : response('private')));
    await h.client.load(); failed = true; await h.client.load(false);
    assert.equal(h.snapshot().data.marker, 'private');
    assert.equal(h.snapshot().error.feishuCode, code);
    h.client.setRange('7d');
    assert.equal(h.snapshot().data.marker, 'private-7d'); assert.equal(h.snapshot().stale, true);
  });
}
for (const code of [401, 99991661, 99991663, 99991664, 99991668]) {
  test(`known Base auth code ${code} clears data`, async t => {
    let failed = false;
    const h = harness(t, sdk(async () => failed ? { code } : response('private')));
    await h.client.load(); failed = true; await h.client.load(false);
    assert.equal(h.snapshot().data, null); assert.equal(h.snapshot().error.code, 'permission_denied');
    h.client.setRange('7d'); assert.equal(h.snapshot().data, null); await h.client.load();
  });
}

test('explicit permission messages clear data even with an unknown API code', async t => {
  let denied = false;
  const h = harness(t, sdk(async () => denied ? { code: 99999999, msg: 'Access denied' } : response('private')));
  await h.client.load(); denied = true; await h.client.load(false);
  assert.equal(h.snapshot().data, null); assert.equal(h.snapshot().error.code, 'permission_denied');
});

test('concurrent loads return the same promise and issue only one SDK read', async t => {
  const pending = deferred(); let reads = 0;
  const h = harness(t, sdk(() => { reads++; return pending.promise; }));
  const first = h.client.load(); assert.equal(h.client.load(false), first);
  await flush(); assert.equal(reads, 1);
  pending.resolve(response('once')); await first; assert.equal(h.snapshot().data.marker, 'once');
});

test('cached range switches render immediately without another SDK request or URL dependency', async t => {
  let reads = 0;
  const h = harness(t, sdk(async () => { reads++; return response('cached'); }));
  await h.client.load(); h.client.setRange('7d');
  assert.equal(h.snapshot().range, '7d'); assert.equal(h.snapshot().data.marker, 'cached-7d');
  h.client.setRange('24h'); assert.equal(h.snapshot().data.marker, 'cached'); assert.equal(reads, 1);
});

test('weekly recovery data is read once and stays independent of the selected chart range', async t => {
  let reads = 0;
  const h = harness(t, sdk(async () => { reads++; return response('cached'); }));
  await h.client.load();
  assert.equal(h.snapshot().data.range, '24h');
  const weekly = h.snapshot().weeklyData;
  assert.equal(weekly.range, '7d');
  assert.equal(weekly.marker, 'cached-7d');
  assert.ok(Object.isFrozen(weekly));
  h.client.setRange('7d');
  assert.equal(h.snapshot().weeklyData, weekly);
  h.client.setRange('24h');
  assert.equal(h.snapshot().weeklyData, weekly);
  assert.equal(reads, 1);
});

for (const [raw, code] of [['{}', 'waiting_first_sync'], ['{', 'bad_response']]) {
  test(`unavailable weekly data does not clear valid 24h charts: ${code}`, async t => {
    const h = harness(t, sdk(async () => response('daily', { payload_7d: raw })));
    await h.client.load();
    assert.equal(h.snapshot().data.marker, 'daily');
    assert.equal(h.snapshot().weeklyData, null);
    assert.equal(h.snapshot().weeklyError, code);
    assert.equal(h.snapshot().error, null);
  });
}

test('range changes during a pending request use the latest range without duplicate reads', async t => {
  const pending = deferred(); let reads = 0;
  const h = harness(t, sdk(() => { reads++; return pending.promise; }));
  const first = h.client.load(); await flush(); h.client.setRange('7d');
  assert.equal(h.client.load(), first); assert.equal(h.snapshot().data, null);
  pending.resolve(response('latest')); await first;
  assert.equal(reads, 1); assert.equal(h.snapshot().range, '7d'); assert.equal(h.snapshot().data.range, '7d');
});

test('missing target payload immediately clears the previous range while awaiting first sync', async t => {
  const pending = deferred(); let reads = 0;
  const empty = response('daily', { payload_7d: '{}' });
  const h = harness(t, sdk(() => ++reads === 1 ? Promise.resolve(empty) : pending.promise));
  await h.client.load(); h.client.setRange('7d');
  assert.equal(h.snapshot().data, null); assert.equal(h.snapshot().error.code, 'waiting_first_sync');
  const second = h.client.load(); pending.resolve(empty); await second;
  assert.equal(h.snapshot().data, null); assert.equal(h.snapshot().error.code, 'waiting_first_sync');
});

test('stop clears timers and prevents a late read from publishing or clobbering a restart', async t => {
  const pending = deferred(); let reads = 0;
  const h = harness(t, sdk(() => ++reads === 1 ? pending.promise : Promise.resolve(response('restarted'))));
  const first = h.client.start(); await flush(); h.client.stop(); const stopped = h.snapshot(); await first;
  assert.equal(h.timers.size, 0); await h.advance(240000); assert.equal(h.snapshot(), stopped); assert.equal(reads, 1);
  await h.client.start(); const restarted = h.snapshot();
  pending.resolve(response('late')); await flush();
  assert.equal(h.snapshot(), restarted); assert.equal(restarted.data.marker, 'restarted');
});

test('stop during initialization cannot launch a record read', async t => {
  const init = deferred(); let reads = 0;
  const h = harness(t, { init: () => init.promise, base_records_get: async () => { reads++; return response('late'); } });
  const loading = h.client.start(); await flush(); h.client.stop();
  await loading; init.resolve({ code: 0 }); await flush();
  assert.equal(reads, 0); assert.equal(h.timers.size, 0);
});

test('polling starts once, skips hidden pages, and keeps cached data out of foreground loading', async t => {
  let reads = 0; const pending = deferred();
  const h = harness(t, sdk(() => ++reads === 1 ? Promise.resolve(response('first')) : pending.promise));
  const first = h.client.start(); assert.equal(h.client.start(), first); await first;
  assert.equal([...h.timers.values()].filter(timer => timer.repeat).length, 1);
  h.state.visible = false; await h.advance(120000); assert.equal(reads, 1);
  h.state.visible = true; await h.advance(120000); assert.equal(reads, 2); assert.equal(h.snapshot().loading, false);
  pending.resolve(response('second')); await flush(); assert.equal(h.snapshot().data.marker, 'second');
});

test('one deadline covers SDK initialization and the subsequent record request', async t => {
  const init = deferred(), read = deferred();
  const h = harness(t, { init: () => init.promise, base_records_get: () => read.promise });
  const loading = h.client.load(); await h.advance(14000);
  init.resolve({ code: 0 }); await flush(); await h.advance(1000); await loading;
  assert.equal(h.snapshot().error.code, 'timeout');
});

test('reader passes exact Base identifiers and joins rich text payload fragments', async t => {
  let received; const text = payload('7d', 'rich-text');
  const h = harness(t, sdk(async (...args) => { received = args; return response('daily', { payload_7d: [{ text: text.slice(0, 20) }, { text: text.slice(20) }] }); }), { initialRange: '7d' });
  await h.client.load();
  assert.deepEqual(received, ['base-test', 'table-test', ['record-test']]);
  assert.equal(h.snapshot().data.marker, 'rich-text');
});

for (const [name, raw] of [
  ['unknown schema', JSON.stringify({ schemaVersion: 'dashboard-v2', range: '24h' })],
  ['missing schema', JSON.stringify({ range: '24h' })],
  ['mismatched range', payload('7d', 'wrong-range')],
  ['malformed JSON', '{'],
]) {
  test(`reader rejects ${name}`, async t => {
    const h = harness(t, sdk(async () => response('invalid', { payload_24h: raw })));
    await h.client.load(); assert.equal(h.snapshot().data, null); assert.equal(h.snapshot().error.code, 'bad_response');
  });
}

test('missing record is reported without rendering a payload', async t => {
  const h = harness(t, sdk(async () => ({ code: 0, data: { records: [] } })));
  await h.client.load(); assert.equal(h.snapshot().data, null); assert.equal(h.snapshot().error.code, 'base_record_missing');
});

test('unbaked init marker is skipped while baked init code is passed to SDK', async t => {
  const codes = [];
  const magic = { init: async code => { codes.push(code); }, base_records_get: async () => response('ready') };
  const h = harness(t, magic, { config: { ...config, initCode: '__UNBAKED_MAGIC_INIT__' } });
  await h.client.load(); assert.deepEqual(codes, []); h.client.stop();
  const baked = createDashboardClient({ config, getMagic: () => magic });
  t.after(() => baked.stop()); await baked.load(); assert.deepEqual(codes, ['test-init']);
});
