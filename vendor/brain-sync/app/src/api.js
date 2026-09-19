export function createApi({ origin, getToken, fetchImpl }) {
  const fetchFn = fetchImpl || globalThis.fetch;
  const base = String(origin || "").replace(/\/+$/, "");

  async function raw(path, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    const token = typeof getToken === "function" ? await getToken() : getToken;
    if (token) headers.authorization = "Bearer " + token;
    const res = await fetchFn(base + path, { ...opts, headers });
    return res;
  }

  async function json(path, opts = {}) {
    const res = await raw(path, opts);
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
    return { ok: res.ok, status: res.status, body, headers: res.headers };
  }

  async function bytes(path, opts = {}) {
    const res = await raw(path, opts);
    const buf = new Uint8Array(await res.arrayBuffer());
    return { ok: res.ok, status: res.status, bytes: buf, headers: res.headers };
  }

  return { raw, json, bytes };
}
