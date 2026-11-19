// Snapchat-style alerts with a safety backup.
//  - New apps say "I can draw alerts myself" (rich) when they register their push token.
//  - Rich phones get a data message: the app draws the alert with the person's photo,
//    grouped by person, with Approve / Decline buttons, and tells the server it arrived (ack).
//  - If no ack comes within ACK_WAIT (battery savers can stop the app), the next 5-minute tick
//    sends the same alert as a plain alert that Android shows by itself. Same tag, so never twice.
//  - A phone that misses twice in a row gets plain alerts only, until it acks again.
import { bad, str } from './util.js';

export const ACK_WAIT = 3 * 60 * 1000;
const MISS_LIMIT = 2;

export function installRich(Store) {
  const P = Store.prototype;

  P.richRoutes = function richRoutes(add) {
    add('POST', '/api/push-ack', this.pushAck, { auth: 'none' });
  };

  P.richState = function richState() {
    return this.db.kvGet('richTokens', {}); // token -> { misses }
  };
  P.isRich = function isRich(token) {
    const r = this.richState()[token];
    return !!r && (r.misses || 0) < MISS_LIMIT;
  };
  P.setRich = function setRich(token, on) {
    const st = this.richState();
    if (on) st[token] = { misses: st[token]?.misses || 0 };
    else delete st[token];
    this.db.kvSet('richTokens', st);
  };

  /** Remember rich alerts that were sent, so a missing ack can be covered by a plain alert. */
  P.rememberRich = function rememberRich(msgs) {
    const rich = msgs.filter((m) => m.rich);
    if (!rich.length) return;
    const acks = this.db.kvGet('pushAcks', {});
    const now = this.now();
    for (const m of rich) acks[`${m.token}|${m.id}`] = { ts: now, token: m.token, id: m.id, title: m.title, body: m.body };
    for (const [k, v] of Object.entries(acks)) if (now - v.ts > 24 * 3600 * 1000) delete acks[k];
    this.db.kvSet('pushAcks', acks);
  };

  P.pushAck = function pushAck({ body }) {
    const token = str(body.token, 400);
    const id = str(body.id, 200);
    if (!token || !id) throw bad('BAD_ACK', 'token and id are needed');
    const acks = this.db.kvGet('pushAcks', {});
    if (acks[`${token}|${id}`]) {
      delete acks[`${token}|${id}`];
      this.db.kvSet('pushAcks', acks);
    }
    const st = this.richState();
    if (st[token] && st[token].misses) { st[token].misses = 0; this.db.kvSet('richTokens', st); }
    return { ok: true };
  };

  /** Called from the 5-minute tick: plain alert for every rich alert that was not acked in time. */
  P.pushFallback = function pushFallback() {
    const acks = this.db.kvGet('pushAcks', {});
    const now = this.now();
    const late = Object.entries(acks).filter(([, v]) => now - v.ts >= ACK_WAIT);
    if (!late.length) return 0;
    const st = this.richState();
    for (const [k, v] of late) {
      delete acks[k];
      this.outbox.push({ token: v.token, id: v.id, title: v.title, body: v.body, rich: false, fallback: true });
      if (st[v.token]) st[v.token].misses = (st[v.token].misses || 0) + 1;
    }
    this.db.kvSet('pushAcks', acks);
    this.db.kvSet('richTokens', st);
    return late.length;
  };
}
