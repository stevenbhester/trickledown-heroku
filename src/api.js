// Thin fetch wrapper. Keeps the token in localStorage and turns API errors
// into thrown Errors with the server's message. Skipped in demo mode, where
// js/demo-api.js has already defined window.API.
(function () {
  if (window.API && window.API.demo) return;
  const BASE = window.TRICKLE_CONFIG.API_BASE;
  const KEY = 'trickledown.token';

  function token() { return localStorage.getItem(KEY); }
  function setToken(t) { if (t) localStorage.setItem(KEY, t); else localStorage.removeItem(KEY); }

  async function call(method, path, body) {
    const headers = { 'Accept': 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const t = token();
    if (t) headers['Authorization'] = `Bearer ${t}`;
    let res;
    try {
      res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      throw new Error("Can't reach the server. Check your connection and try again.");
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  window.API = {
    token, setToken,
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b || {}),
  };
})();
