// Offline punch queue for the staff app.
// A punch made without internet is saved on the phone with the best estimate of SERVER time
// (phone clock + last known offset) and sent as soon as the internet is back.
// The server checks it again (location, order, age) and marks it as "offline".
import { api, LS } from './api.js';

const KEY = 'afford.queue';
const listeners = new Set();

export function queued() {
  try { return JSON.parse(LS.get(KEY) || '[]'); } catch { return []; }
}
function save(q) {
  LS.set(KEY, JSON.stringify(q));
  listeners.forEach((f) => f(q));
}
export const onQueue = (f) => { listeners.add(f); return () => listeners.delete(f); };

export function enqueue(p) {
  const q = queued();
  q.push({ ...p, offlineTs: api.serverNow(), clientId: p.clientId || `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
  save(q);
  return q[q.length - 1];
}

let flushing = false;
/** Send saved punches in order. Returns {sent, failed: [{punch, error}]} */
export async function flush() {
  if (flushing) return { sent: 0, failed: [] };
  flushing = true;
  let sent = 0;
  const failed = [];
  try {
    let q = queued();
    while (q.length) {
      const p = q[0];
      try {
        await api.post('/api/emp/punch', p, { timeoutMs: 15000 });
        sent++;
      } catch (e) {
        if (e.code === 'NETWORK') break; // still offline: keep the rest
        failed.push({ punch: p, error: e }); // refused by the server: drop it, tell the user
      }
      q = queued().slice(1);
      save(q);
    }
  } finally { flushing = false; }
  return { sent, failed };
}
