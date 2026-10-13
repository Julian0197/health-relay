const fieldText = value => typeof value === 'string' ? value
  : Array.isArray(value) ? value.map(part => part.text || '').join('') : '';

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

function dtoFromFields(fields, range, payloads) {
  const raw = fieldText(fields[range === '7d' ? 'payload_7d' : 'payload_24h']);
  if (!raw || raw === '{}') throw { code: 'waiting_first_sync' };
  const cached = payloads.get(range);
  if (cached?.raw === raw) return cached.data;
  let dto;
  try { dto = JSON.parse(raw); } catch { throw { code: 'bad_response' }; }
  if (dto?.schemaVersion !== 'dashboard-v1' || (dto.range !== undefined && dto.range !== range)) {
    throw { code: 'bad_response' };
  }
  payloads.set(range, { raw, data: dto });
  return dto;
}

function isPermissionDenied(error) {
  const code = Number(error?.feishuCode ?? error?.code);
  return [401, 403, 99991661, 99991663, 99991664, 99991668].includes(code)
    || /permission[_ -]?denied|access[_ -]?denied|unauthori[sz]ed|forbidden|无权限|拒绝授权/i.test(`${error?.code || ''} ${error?.message || ''}`);
}

function apiError(response) {
  return { code: 'base_read_failed', feishuCode: response?.code ?? null, message: response?.msg || response?.message };
}

const isRuntimeExpired = error => /invalid runtime session/i.test(error?.message ?? '');

function normalizeError(error) {
  return {
    code: error?.name === 'TimeoutError' ? 'timeout' : error?.code || 'unknown',
    ...(error?.message ? { message: error.message } : {}),
    ...(error?.feishuCode != null ? { feishuCode: error.feishuCode } : {}),
  };
}

export function createDashboardClient({
  config,
  getMagic = () => window.magic,
  timeoutMs = 15000,
  pollMs = 120000,
  isVisible = () => !document.hidden,
  initialRange = '24h',
}) {
  let snapshot = freeze({ range: initialRange, data: null, weeklyData: null, weeklyError: null, loading: false, error: null, stale: false });
  let cachedFields = null, magicInited = false, activeLoad = null, pollTimer = null, stopped = false;
  const subscribers = new Set();
  // At most two parsed windows. Compare the full payload, including evaluation times.
  const payloads = new Map();

  function publish(change) {
    if (Object.keys(change).every(key => Object.is(change[key], snapshot[key]))) return;
    snapshot = freeze({ ...snapshot, ...change });
    subscribers.forEach(listener => listener());
  }

  async function fetchRecord(operation) {
    const check = () => { if (!operation.active) throw { code: 'cancelled' }; };
    check();
    let deadline, waitTimer, wake;
    const expired = new Promise((_, reject) => {
      deadline = setTimeout(() => {
        operation.active = false;
        reject({ code: 'timeout' });
      }, timeoutMs);
      operation.cancel = () => {
        operation.active = false;
        reject({ code: 'cancelled' });
      };
    });
    const read = async () => {
      let magic = getMagic();
      while (!magic?.base_records_get) {
        check();
        await new Promise(resolve => { wake = resolve; waitTimer = setTimeout(resolve, 200); });
        check();
        magic = getMagic();
      }
      check();
      const hasInitCode = config.initCode != null && config.initCode !== '__UNBAKED_MAGIC_INIT__';
      const initialize = async () => {
        if (hasInitCode) {
          const auth = await magic.init(config.initCode);
          check();
          if (auth?.code != null && auth.code !== 0) throw apiError(auth);
        }
        check();
        magicInited = true;
      };
      if (!magicInited) await initialize();
      let response;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          response = await magic.base_records_get(config.base, config.table, [config.record]);
          check();
          if (response?.code !== 0) throw apiError(response);
          break;
        } catch (error) {
          check();
          if (attempt !== 0 || !hasInitCode || !isRuntimeExpired(error)) throw error;
          magicInited = false;
          await initialize();
        }
      }
      const record = response.data?.records?.[0];
      if (!record) throw { code: 'base_record_missing' };
      return record.fields ?? {};
    };
    try {
      return await Promise.race([read(), expired]);
    } finally {
      operation.active = false;
      clearTimeout(deadline);
      clearTimeout(waitTimer);
      wake?.();
    }
  }

  // Keep this function synchronous so concurrent callers receive the identical promise.
  function load(showLoading = true) {
    if (activeLoad) return activeLoad.promise;
    if (stopped) return Promise.resolve();
    const operation = { active: true, cancel: null, promise: null };
    activeLoad = operation;
    operation.promise = Promise.resolve()
      .then(() => fetchRecord(operation))
      .then(fields => {
        if (activeLoad !== operation) return;
        // A Base read contains both windows. Select the range at completion, not dispatch.
        const data = dtoFromFields(fields, snapshot.range, payloads);
        let weeklyData = null, weeklyError = null;
        try { weeklyData = dtoFromFields(fields, '7d', payloads); }
        catch (error) { weeklyError = normalizeError(error).code; }
        cachedFields = fields;
        publish({ data, weeklyData, weeklyError, loading: false, error: null, stale: false });
      })
      .catch(cause => {
        if (activeLoad !== operation) return;
        const error = normalizeError(cause);
        const denied = isPermissionDenied(error) || isRuntimeExpired(error);
        if (denied) {
          cachedFields = null;
          payloads.clear();
          magicInited = false;
          error.code = isRuntimeExpired(error) ? 'session_expired' : 'permission_denied';
        }
        publish({ data: denied ? null : snapshot.data,
          weeklyData: denied ? null : snapshot.weeklyData,
          weeklyError: denied ? null : snapshot.weeklyError,
          loading: false, error, stale: true });
      })
      .finally(() => { if (activeLoad === operation) activeLoad = null; });
    publish({ loading: showLoading || !snapshot.data });
    return operation.promise;
  }

  function setRange(range) {
    if (range !== '24h' && range !== '7d') throw new RangeError('Unsupported dashboard range');
    if (range === snapshot.range) return;
    if (cachedFields) {
      try {
        const data = dtoFromFields(cachedFields, range, payloads);
        publish({ range, data, error: snapshot.stale ? snapshot.error : null });
        return;
      } catch (error) {
        publish({ range, data: null, error: normalizeError(error) });
      }
    } else {
      publish({ range, data: null });
    }
    return load(true);
  }

  function start() {
    if (pollTimer !== null) return activeLoad?.promise ?? Promise.resolve();
    stopped = false;
    // Polling must be established even when SDK injection or authorization hangs.
    pollTimer = setInterval(() => { if (isVisible()) load(false); }, pollMs);
    return load();
  }

  function stop() {
    stopped = true;
    clearInterval(pollTimer);
    pollTimer = null;
    const operation = activeLoad;
    activeLoad = null;
    if (operation) {
      operation.active = false;
      operation.cancel?.();
    }
    publish({ loading: false });
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); },
    start,
    stop,
    load,
    setRange,
  };
}
