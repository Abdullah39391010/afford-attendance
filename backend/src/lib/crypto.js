// PIN hashing (PBKDF2-SHA256 + per-PIN salt + server pepper) and session tokens.
// Iterations are kept modest so a login fits inside the Workers free-plan CPU budget;
// brute force is stopped by the rate limiter, and the pepper (a Worker secret) means a
// copy of the database alone is not enough to try PINs offline.

const ITER = 20000;
const enc = new TextEncoder();

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));

async function derive(pin, salt, pepper, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(`${pepper}:${pin}`), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
  return hex(bits);
}

export async function hashPin(pin, pepper) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `p1$${ITER}$${hex(salt)}$${await derive(pin, salt, pepper, ITER)}`;
}

export async function checkPin(pin, stored, pepper) {
  if (!stored || typeof pin !== 'string') return false;
  const [v, iter, salt, hash] = stored.split('$');
  if (v !== 'p1') return false;
  const got = await derive(pin, unhex(salt), pepper, Number(iter));
  // constant-time compare
  let diff = got.length ^ hash.length;
  for (let i = 0; i < Math.min(got.length, hash.length); i++) diff |= got.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}

export function newToken() {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256(s) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

export function validPin(pin) {
  return typeof pin === 'string' && /^\d{4,6}$/.test(pin);
}
