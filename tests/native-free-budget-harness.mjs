// Clock and counters for isolated workerd quota tests; never a deployment entrypoint.
import { NativeHealthStore, handleNativeRequest } from '../integrations/hae-webhook/native-worker.mjs';
export class NativeBudgetStore extends NativeHealthStore {
  constructor(ctx, env) {
    const clock = { offset: 0 };
    super(ctx, env, fetch, () => Date.now()+clock.offset);
    clock.offset = this.repo.state('testOffset') ?? 0;
    this.testClock = clock; this.evaluations = 0;
    const view = this.repo.view.bind(this.repo);
    this.repo.view = (...args) => { this.evaluations++; return view(...args); };
  }
  async stats() {
    const alarmAt = await this.storage.getAlarm(), reception = this.repo.state('reception');
    return Response.json({ sqlUsage: { ...this.sqlUsage }, readStats: { ...this.repo.readStats },
      evaluations: this.evaluations, alarmAt, reception });
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/__time') {
      this.testClock.offset = (await request.json()).now-Date.now();
      this.repo.saveState('testOffset', this.testClock.offset);
      return this.stats();
    }
    if (path === '/__alarm') { await this.alarm(); return this.stats(); }
    if (path === '/__stats') return this.stats();
    return super.fetch(request);
  }
}
export default { fetch(request, env) {
  if (new URL(request.url).pathname.startsWith('/__')) return env.NATIVE_STORE.get(env.NATIVE_STORE.idFromName('personal')).fetch(request);
  return handleNativeRequest(request, env);
} };
