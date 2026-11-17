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
      this.store = new Store(new DB(ctx.storage.sql), env);
      if ((await ctx.storage.getAlarm()) == null) await ctx.storage.setAlarm(Date.now() + 3600 * 1000);
    });
  }
  async fetch(request) {
    return this.store.handle(request);
  }
  async alarm() {
    this.store.cleanup();
    await this.ctx.storage.setAlarm(Date.now() + 24 * 3600 * 1000);
  }
}

/** Latest release info for the in-app update popup (cached for 10 minutes). */
async function latestRelease(env, app, ctx) {
  const repo = env.GITHUB_REPO;
  if (!repo) return { version: null };
  const cache = caches.default;
  const key = new Request(`https://cache.local/release/${repo}/${app}`);
  const hit = await cache.match(key);
  if (hit) return hit.json();
  let out = { version: null };
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=20`, {
      headers: { 'user-agent': 'afford-attendance-worker', accept: 'application/vnd.github+json' },
    });
    if (res.ok) {
      const list = await res.json();
      const rel = list.find((r) => !r.draft && !r.prerelease && r.assets?.some((a) => a.name.startsWith(`afford-${app}`)));
      if (rel) {
        const asset = rel.assets.find((a) => a.name.startsWith(`afford-${app}`) && a.name.endsWith('.apk'));
        out = {
          version: (rel.tag_name.match(/\d+\.\d+\.\d+/) || [null])[0],
          notes: rel.body || '',
          url: asset?.browser_download_url || rel.html_url,
          published: rel.published_at,
        };
      }
    }
  } catch {
    /* offline or rate limited: report no update */
  }
  const resp = new Response(JSON.stringify(out), { headers: { 'cache-control': 'max-age=600', 'content-type': 'application/json' } });
  ctx.waitUntil(cache.put(key, resp.clone()));
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
