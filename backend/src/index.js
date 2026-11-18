// Worker entry: CORS, app-update info from GitHub Releases, static owner page, and
// forwarding of every /api call to the store's Durable Object.
import { DurableObject } from 'cloudflare:workers';
import { DB } from './lib/db.js';
import { Store } from './lib/store.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, x-device-id, x-app-version',
  'access-control-max-age': '86400',
};

function withCors(res) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS)) r.headers.set(k, v);
  r.headers.set('x-content-type-options', 'nosniff');
  return r;
}

export class StoreDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      // Full wipe on request of the owner: changing WIPE_TOKEN in wrangler.toml erases ALL data once.
      // Keep the value the same on later deploys or the data is erased again.
      if (env.WIPE_TOKEN && (await ctx.storage.get('wipedFor')) !== env.WIPE_TOKEN) {
        await ctx.storage.deleteAll();
        await ctx.storage.deleteAlarm();
        await ctx.storage.put('wipedFor', env.WIPE_TOKEN);
      }
      this.store = new Store(new DB(ctx.storage.sql), env);
      if (env.VAULT) this.store.vault = vaultClient(env.VAULT);
      const next = await ctx.storage.getAlarm();
      if (next == null || next > Date.now() + 5 * 60 * 1000) await ctx.storage.setAlarm(Date.now() + 60 * 1000);
    });
  }
  async fetch(request) {
    return this.store.handle(request);
  }
  // runs every 5 minutes: reminders and the nightly summary; housekeeping and the cloud backup once a day
  async alarm() {
    try {
      await this.store.tick();
      const last = (await this.ctx.storage.get('cleanedAt')) || 0;
      if (Date.now() - last > 23 * 3600 * 1000) {
        this.store.cleanup();
        await this.ctx.storage.put('cleanedAt', Date.now());
      }
      await this.store.dailyCloudBackup();
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + 5 * 60 * 1000);
    }
  }
}

/** Backups live in their own Durable Object. Big files are split into 1 MB pieces. */
export class VaultDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS backups (name TEXT PRIMARY KEY, created INTEGER NOT NULL, size INTEGER NOT NULL, parts INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS parts (name TEXT NOT NULL, idx INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (name, idx))');
  }
  async put(name, text) {
    const size = 1_000_000;
    const n = Math.max(1, Math.ceil(text.length / size));
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM parts WHERE name = ?', name);
      for (let i = 0; i < n; i++) this.sql.exec('INSERT INTO parts (name, idx, data) VALUES (?, ?, ?)', name, i, text.slice(i * size, (i + 1) * size));
      this.sql.exec('INSERT OR REPLACE INTO backups (name, created, size, parts) VALUES (?, ?, ?, ?)', name, Date.now(), text.length, n);
    });
    return true;
  }
  async list() {
    return this.sql.exec('SELECT name, created, size FROM backups ORDER BY name DESC').toArray();
  }
  async get(name) {
    const rows = this.sql.exec('SELECT data FROM parts WHERE name = ? ORDER BY idx', name).toArray();
    return rows.length ? rows.map((r) => r.data).join('') : null;
  }
  async remove(name) {
    this.sql.exec('DELETE FROM parts WHERE name = ?', name);
    this.sql.exec('DELETE FROM backups WHERE name = ?', name);
    return true;
  }
}

function vaultClient(ns) {
  const stub = () => ns.get(ns.idFromName('vault'));
  return {
    put: (name, text) => stub().put(name, text),
    list: () => stub().list(),
    get: (name) => stub().get(name),
    remove: (name) => stub().remove(name),
  };
}

/** Latest release info for the in-app update popup.
 * GitHub's API allows only 60 calls an hour per IP without a token, and Cloudflare's IPs are shared,
 * so it is often refused. Then the public releases feed is used instead (not rate limited). */
async function latestRelease(env, app, ctx) {
  const repo = env.GITHUB_REPO;
  if (!repo) return { version: null };
  const cache = caches.default;
  const key = new Request(`https://cache.local/release2/${repo}/${app}`);
  const hit = await cache.match(key).catch(() => null);
  if (hit) return hit.json();
  const ua = { 'user-agent': 'afford-attendance-worker' };
  let out = { version: null };
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=20`, { headers: { ...ua, accept: 'application/vnd.github+json' } });
    if (res.ok) {
      const list = await res.json();
      const rel = list.find((r) => !r.draft && !r.prerelease && r.assets?.some((a) => a.name.startsWith(`afford-${app}`) && a.name.endsWith('.apk')));
      if (rel) {
        const asset = rel.assets.find((a) => a.name.startsWith(`afford-${app}`) && a.name.endsWith('.apk'));
        out = { version: (rel.tag_name.match(/\d+\.\d+\.\d+/) || [null])[0], notes: rel.body || '', url: asset.browser_download_url, published: rel.published_at, via: 'api' };
      }
    }
  } catch { /* fall back below */ }
  if (!out.version) {
    try {
      const feed = await (await fetch(`https://github.com/${repo}/releases.atom`, { headers: ua })).text();
      const tags = [...feed.matchAll(/\/releases\/tag\/(v(\d+\.\d+\.\d+)-\d+)/g)];
      for (const [, tag, ver] of tags) {
        const url = `https://github.com/${repo}/releases/download/${tag}/afford-${app}-${ver}.apk`;
        const head = await fetch(url, { method: 'HEAD', headers: ua, redirect: 'manual' });
        if (head.status >= 400) continue; // this release has no APK for this app
        let notes = '';
        try {
          const vj = await (await fetch(`https://raw.githubusercontent.com/${repo}/${tag}/apps/version.json`, { headers: ua })).json();
          notes = `${vj.notes?.en || ''}\n\nUR: ${vj.notes?.ur || ''}`;
        } catch { /* no notes */ }
        out = { version: ver, notes, url, via: 'feed' };
        break;
      }
    } catch { /* offline: no update */ }
  }
  if (out.version) {
    const resp = new Response(JSON.stringify(out), { headers: { 'cache-control': 'max-age=300', 'content-type': 'application/json' } });
    ctx.waitUntil(cache.put(key, resp.clone()).catch(() => {}));
  }
  return out;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === '/api/app/latest') {
      const app = url.searchParams.get('app') === 'admin' ? 'admin' : 'employee';
      return withCors(Response.json(await latestRelease(env, app, ctx)));
    }
    if (url.pathname.startsWith('/api/')) {
      const storeId = env.STORE_ID || 'afford';
      const stub = env.STORE.get(env.STORE.idFromName(storeId));
      return withCors(await stub.fetch(request));
    }
    if (env.ASSETS) {
      if (url.pathname === '/' ) return Response.redirect(`${url.origin}/owner/`, 302);
      return env.ASSETS.fetch(request);
    }
    return new Response('Afford attendance API', { status: 200 });
  },
};
