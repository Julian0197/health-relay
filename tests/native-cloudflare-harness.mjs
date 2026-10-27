// Isolated runtime controls. This module is never the production deployment entrypoint.
import { NativeHealthStore, handleNativeRequest } from '../integrations/hae-webhook/native-worker.mjs';
export class NativeRuntimeStore extends NativeHealthStore {
  constructor(ctx, env) {
    const clock = { offset: 0 };
    super(ctx, env, fetch, () => Date.now()+clock.offset);
    clock.offset = this.repo.state('testOffset') ?? 0;
    this.testClock = clock;
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/__advance') {
      this.testClock.offset = (await request.json()).now - Date.now();
      this.repo.saveState('testOffset', this.testClock.offset);
      await this.alarm();
      return Response.json(this.status());
    }
    if (path === '/__storage-failure') {
      this.storage.sql.exec("CREATE TRIGGER reject_fixture BEFORE INSERT ON native_records BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END");
      return Response.json({ ok: true });
    }
    if (path === '/__recover-storage') {
      this.storage.sql.exec('DROP TRIGGER reject_fixture');
      return Response.json({ ok: true });
    }
    return super.fetch(request);
  }
}
export default { fetch(request, env) {
  if (new URL(request.url).pathname.startsWith('/__')) return env.NATIVE_STORE.get(env.NATIVE_STORE.idFromName('personal')).fetch(request);
  return handleNativeRequest(request, env);
} };
