// Thin wrapper over the Durable Object SQLite API (ctx.storage.sql) so the same code
// runs in tests on Node's built-in sqlite.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS admins (id TEXT PRIMARY KEY, name TEXT NOT NULL, login TEXT NOT NULL UNIQUE,
     role TEXT NOT NULL, perms TEXT NOT NULL DEFAULT '[]', pin TEXT, active INTEGER NOT NULL DEFAULT 1,
     created INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS employees (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, data TEXT NOT NULL,
     photo TEXT, pin TEXT, device TEXT, device_name TEXT, active INTEGER NOT NULL DEFAULT 1,
     deleted INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS punches (id TEXT PRIMARY KEY, emp TEXT NOT NULL, day TEXT NOT NULL, type TEXT NOT NULL,
     ts INTEGER NOT NULL, client_id TEXT, offline INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL,
     lat REAL, lng REAL, acc REAL, dist REAL, by_admin TEXT, reason TEXT, voided INTEGER NOT NULL DEFAULT 0,
     created INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS punches_emp_day ON punches(emp, day)`,
  `CREATE INDEX IF NOT EXISTS punches_day ON punches(day)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS punches_client ON punches(emp, client_id)`,
  `CREATE TABLE IF NOT EXISTS day_marks (emp TEXT NOT NULL, day TEXT NOT NULL, status TEXT NOT NULL, note TEXT,
     by_admin TEXT, ts INTEGER NOT NULL, PRIMARY KEY (emp, day))`,
  `CREATE TABLE IF NOT EXISTS breaks (id TEXT PRIMARY KEY, emp TEXT NOT NULL, day TEXT NOT NULL, start INTEGER NOT NULL,
     end INTEGER, allowed INTEGER NOT NULL, request_id TEXT)`,
  `CREATE INDEX IF NOT EXISTS breaks_emp_day ON breaks(emp, day)`,
  `CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, emp TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL,
     status TEXT NOT NULL, note TEXT, created INTEGER NOT NULL, decided INTEGER, decided_by TEXT)`,
  `CREATE INDEX IF NOT EXISTS requests_status ON requests(status, created)`,
  `CREATE INDEX IF NOT EXISTS requests_emp ON requests(emp, created)`,
  `CREATE TABLE IF NOT EXISTS money (id TEXT PRIMARY KEY, emp TEXT NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL,
     month TEXT NOT NULL, note TEXT, ts INTEGER NOT NULL, by_admin TEXT, voided INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS money_emp ON money(emp, month)`,
  `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, kind TEXT NOT NULL, sub TEXT NOT NULL, device TEXT,
     created INTEGER NOT NULL, expires INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sessions_sub ON sessions(kind, sub)`,
  `CREATE TABLE IF NOT EXISTS pin_fail (key TEXT PRIMARY KEY, count INTEGER NOT NULL, locks INTEGER NOT NULL DEFAULT 0,
     until INTEGER NOT NULL DEFAULT 0, last INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor TEXT,
     actor_name TEXT, action TEXT NOT NULL, target TEXT, detail TEXT)`,
  `CREATE TABLE IF NOT EXISTS push_tokens (token TEXT PRIMARY KEY, kind TEXT NOT NULL, sub TEXT NOT NULL, lang TEXT,
     updated INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS push_tokens_sub ON push_tokens(kind, sub)`,
  `CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, kind TEXT NOT NULL, emp TEXT NOT NULL, data TEXT NOT NULL,
     status TEXT NOT NULL, created INTEGER NOT NULL, by_admin TEXT, by_name TEXT, decided INTEGER, note TEXT)`,
  `CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, punch TEXT NOT NULL, data TEXT NOT NULL, ts INTEGER NOT NULL)`,
];

const fix = (p) => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));

export class DB {
  /** @param {{exec:(sql:string,...p:any[])=>{toArray():any[]}}} sql */
  constructor(sql) {
    this.sql = sql;
  }
  migrate() {
    for (const s of SCHEMA) this.sql.exec(s);
  }
  all(q, ...p) {
    return this.sql.exec(q, ...fix(p)).toArray();
  }
  get(q, ...p) {
    return this.all(q, ...p)[0] || null;
  }
  run(q, ...p) {
    this.sql.exec(q, ...fix(p)).toArray();
  }
  kvGet(k, dflt = null) {
    const r = this.get('SELECT v FROM kv WHERE k = ?', k);
    return r ? JSON.parse(r.v) : dflt;
  }
  kvSet(k, v) {
    this.run('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, JSON.stringify(v));
  }
}
