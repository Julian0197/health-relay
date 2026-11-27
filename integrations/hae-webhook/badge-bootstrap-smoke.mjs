// Synthetic upgrade test: old persisted health data has no device snapshot yet.
// Uses Miniflare's local SQL inspection only; never connects to production.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export async function verifyBadgeBootstrap(Miniflare, convertOptions, options) {
  const directory = await mkdtemp(join(tmpdir(), 'hae-badge-upgrade-'));
  let outbound = 0, runtime;
  const worker = options.workers[0];
  // Miniflare's SQL inspector uses RPC. Add the base class only to this local
  // fixture; production modules and the ordinary runtime smoke stay unchanged.
  const modules = await Promise.all(worker.modules.map(async module => {
    if (!module.path.endsWith('/health-store.mjs')) return module;
    const source = await readFile(module.path, 'utf8');
    return { ...module, contents: "import { DurableObject } from 'cloudflare:workers';\n" + source
      .replace('export class HealthStore {', 'export class HealthStore extends DurableObject {')
      .replace('constructor(ctx, env, send = fetch, clock = Date.now) {',
        'constructor(ctx, env, send = fetch, clock = Date.now) { super(ctx, env);') };
  }));
  const current = { ...options, unsafeInspectDurableObjects: true, resourcePersistencePath: directory, workers: [{ ...worker, modules,
    bindings: { ...worker.bindings, SIGNATURE_ENABLED: 'false' },
    outboundService: () => { outbound++; throw new Error('badge bootstrap must not make external requests'); },
  }] };
  const oldModules = await Promise.all(modules.map(async module => {
    if (!module.path.endsWith('/health-store.mjs')) return module;
    const source = module.contents;
    const currentHandler = "const payload = readBadgeCache(state.badgeCache, now) ??\n          (state.dataRevision > 0 ? await this.bootstrapBadgeCache(now) : null);";
    assert.ok(source.includes(currentHandler), 'upgrade fixture must disable the actual cold-bootstrap handler');
    return { ...module, contents: source.replace(currentHandler, 'const payload = readBadgeCache(state.badgeCache, now);') };
  }));
  const legacy = { ...current, workers: [{ ...current.workers[0], modules: oldModules }] };
  const headers = { 'X-API-Key': 'fixture-badge-only' };
  const tables = ['samples', 'sample_day_cache', 'sample_counts', 'pressure_observations',
    'pressure_observation_basis', 'pressure_history_meta', 'sql_read_usage'];
  const sqlSnapshot = async () => {
    const storage = await runtime.unsafeGetDurableObjectStorage(worker.name, 'HealthStore', { name: 'personal' });
    return Object.fromEntries(await Promise.all(tables.map(async table => [table,
      (await storage.exec(`SELECT * FROM ${table}`)).map(row => JSON.stringify(row)).sort()])));
  };
  try {
    runtime = new Miniflare(convertOptions(legacy));
    const date = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const upload = await runtime.dispatchFetch('http://local/ingest/health', { method: 'POST',
      headers: { 'X-API-Key': 'fixture', 'X-HAE-Aggregation': 'days', 'X-HAE-Mode': 'backfill' },
      body: JSON.stringify({ data: { metrics: [{ name: 'step_count', units: 'count', data: [{ date, qty: 1234 }] }] } }) });
    assert.equal(upload.status, 200, await upload.text());
    assert.equal((await runtime.dispatchFetch('http://local/badge', { headers })).status, 503,
      'legacy device cache must be absent despite accepted data');
    const before = await sqlSnapshot();
    await runtime.dispose(); runtime = new Miniflare(convertOptions(current));
    const responses = await Promise.all([1, 2, 3].map(() => runtime.dispatchFetch('http://local/badge', { headers })));
    const payloads = await Promise.all(responses.map(async response => {
      assert.equal(response.status, 200, await response.clone().text()); return response.json();
    }));
    assert.equal(payloads[0].v, 3); assert.equal(payloads[0].steps, 1234); assert.equal(payloads[0].day, date);
    assert.deepEqual(payloads[0], payloads[1]); assert.deepEqual(payloads[1], payloads[2]);
    assert.deepEqual(await sqlSnapshot(), before, 'bootstrap must not modify health facts, history or SQL meter');
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(await (await runtime.dispatchFetch('http://local/badge', { headers })).json(), payloads[0]);
    }
    await runtime.dispose(); runtime = new Miniflare(convertOptions(current));
    assert.deepEqual(await (await runtime.dispatchFetch('http://local/badge', { headers })).json(), payloads[0],
      'the new device cache must survive a real runtime restart');
    assert.deepEqual(await sqlSnapshot(), before);
    assert.equal(outbound, 0);
    console.log('Runtime upgrade PASS: existing accepted data bootstraps once, concurrent polls and restart reuse V3, no health/history/meter writes or outbound requests.');
  } finally { await runtime?.dispose(); await rm(directory, { recursive: true, force: true }); }
}
