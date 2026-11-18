// API client shared by both apps. Keeps the server-time offset so offline punches use server time.
import { AffordDevice } from 'afford-device';

const LS = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* ignore */ } },
};
export { LS };

export class ApiError extends Error {
  constructor(code, message, status, data) {
    super(message || code);
    this.code = code;
    this.status = status;
    this.data = data || {};
  }
}

const state = {
  // the iPhone web version is served by the server itself, so it always talks to the same address
  base: (typeof __WEB_APP__ !== 'undefined' && __WEB_APP__ ? location.origin : LS.get('afford.api') || __API_URL__ || '').replace(/\/+$/, ''),
  token: null,
  deviceId: null,
  offset: Number(LS.get('afford.offset') || 0), // serverTime - Date.now()
  onAuthLost: null,
};

export const api = {
  get base() { return state.base; },
  setBase(url) {
    state.base = String(url || '').trim().replace(/\/+$/, '');
    LS.set('afford.api', state.base);
  },
  get token() { return state.token; },
  setToken(t) { state.token = t; },
  setDevice(id) { state.deviceId = id; },
  onAuthLost(fn) { state.onAuthLost = fn; },
  /** Best estimate of server time right now. */
  serverNow() { return Date.now() + state.offset; },
  noteServerTime(ts) {
    if (!ts) return;
    state.offset = ts - Date.now();
    LS.set('afford.offset', String(state.offset));
  },
  url(path) { return state.base + path; },

  async call(method, path, body, { raw = false, timeoutMs = 20000 } = {}) {
    if (!state.base) throw new ApiError('NO_SERVER', 'Server address is not set');
    const headers = { 'content-type': 'application/json' };
    if (state.token) headers.authorization = `Bearer ${state.token}`;
    if (state.deviceId) headers['x-device-id'] = state.deviceId;
    headers['x-app-version'] = `${__APP_KIND__}/${__APP_VERSION__}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    const t0 = Date.now();
    try {
      res = await fetch(state.base + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
    } catch (e) {
      throw new ApiError('NETWORK', 'No internet connection');
    } finally {
      clearTimeout(timer);
    }
    if (raw) {
      if (!res.ok) throw new ApiError('HTTP', `Error ${res.status}`, res.status);
      return res;
    }
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (data && data.serverTime && Date.now() - t0 < 3000) api.noteServerTime(data.serverTime + Math.round((Date.now() - t0) / 2));
    if (!res.ok) {
      const err = new ApiError(data?.error || 'HTTP', data?.message || `Error ${res.status}`, res.status, data);
      if (res.status === 401 && ['BAD_TOKEN', 'NO_TOKEN', 'DEVICE_RESET'].includes(err.code) && state.onAuthLost) state.onAuthLost(err);
      throw err;
    }
    return data;
  },
  get(p, o) { return api.call('GET', p, null, o); },
  post(p, b, o) { return api.call('POST', p, b || {}, o); },
  put(p, b, o) { return api.call('PUT', p, b || {}, o); },
  del(p, o) { return api.call('DELETE', p, null, o); },

  /** Authenticated image URL -> blob URL (photos need the token). */
  async image(path) {
    const res = await api.call('GET', path, null, { raw: true });
    return URL.createObjectURL(await res.blob());
  },
};

export async function deviceInfo() {
  try { return await AffordDevice.getInfo(); } catch { return { deviceId: 'unknown-device', model: '' }; }
}
