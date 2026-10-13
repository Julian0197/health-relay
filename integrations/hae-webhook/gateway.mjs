// Stable public name; both URLs share one backend, key and personal data store.
export default { fetch: (request, env) => env.HEALTH_BACKEND.fetch(request) };
