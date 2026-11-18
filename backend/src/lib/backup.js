// Full backup / restore of the store's data as one JSON file.
// Punch selfies (photos table) are left out to keep the file small; profile photos are kept.
// Sessions and PIN-lock counters are not part of a backup.

export const BACKUP_FORMAT = 'afford-backup';
export const BACKUP_VERSION = 1;

/** Columns per table. Restore only writes these names, so a file cannot inject SQL. */
export const TABLES = {
  kv: ['k', 'v'],
  admins: ['id', 'name', 'login', 'role', 'perms', 'pin', 'active', 'created'],
  employees: ['id', 'code', 'data', 'photo', 'pin', 'device', 'device_name', 'active', 'deleted', 'created', 'updated'],
  punches: ['id', 'emp', 'day', 'type', 'ts', 'client_id', 'offline', 'source', 'lat', 'lng', 'acc', 'dist', 'by_admin', 'reason', 'voided', 'created'],
  day_marks: ['emp', 'day', 'status', 'note', 'by_admin', 'ts'],
  breaks: ['id', 'emp', 'day', 'start', 'end', 'allowed', 'request_id'],
  requests: ['id', 'emp', 'type', 'data', 'status', 'note', 'created', 'decided', 'decided_by'],
  money: ['id', 'emp', 'kind', 'amount', 'month', 'note', 'ts', 'by_admin', 'voided'],
  audit: ['id', 'ts', 'actor', 'actor_name', 'action', 'target', 'detail'],
  payments: ['id', 'emp', 'month', 'amount', 'method', 'note', 'ts', 'by_admin', 'voided'],
  approvals: ['id', 'kind', 'emp', 'data', 'status', 'created', 'by_admin', 'by_name', 'decided', 'note'],
};

export function makeBackup(db, meta) {
  const tables = {};
  for (const [t, cols] of Object.entries(TABLES)) {
    tables[t] = db.all(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM ${t}`).map((r) => cols.map((c) => r[c] ?? null));
  }
  const counts = Object.fromEntries(Object.entries(tables).map(([t, rows]) => [t, rows.length]));
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, ...meta, counts, columns: TABLES, tables };
}

/** Checks a backup file and returns a short summary, or throws a message. */
export function checkBackup(b) {
  if (!b || typeof b !== 'object' || b.format !== BACKUP_FORMAT) throw new Error('This is not an Afford backup file');
  if (typeof b.version !== 'number' || b.version > BACKUP_VERSION) throw new Error('This backup is from a newer app version');
  if (!b.tables || typeof b.tables !== 'object') throw new Error('The backup file is damaged');
  for (const t of ['kv', 'admins', 'employees']) if (!Array.isArray(b.tables[t])) throw new Error('The backup file is damaged');
  if (!b.tables.admins.length) throw new Error('The backup has no owner account');
  const cols = b.columns || TABLES;
  for (const [t, rows] of Object.entries(b.tables)) {
    if (!TABLES[t]) continue;
    if (!Array.isArray(rows) || !Array.isArray(cols[t])) throw new Error('The backup file is damaged');
    if (cols[t].some((c) => !TABLES[t].includes(c))) throw new Error('The backup file is damaged');
    for (const r of rows) if (!Array.isArray(r) || r.length !== cols[t].length) throw new Error('The backup file is damaged');
  }
  return {
    created: b.created || null,
    storeName: b.storeName || '',
    employees: b.tables.employees.filter((r) => !r[cols.employees.indexOf('deleted')]).length,
    punches: (b.tables.punches || []).length,
  };
}

/** Replaces all data with the backup. Synchronous, so the Durable Object writes it as one unit. */
export function applyBackup(db, b) {
  const cols = b.columns || TABLES;
  for (const t of Object.keys(TABLES)) db.run(`DELETE FROM ${t}`);
  db.run('DELETE FROM photos');
  db.run('DELETE FROM pin_fail');
  for (const t of Object.keys(TABLES)) {
    const rows = b.tables[t];
    if (!Array.isArray(rows) || !rows.length) continue;
    const c = cols[t];
    const sql = `INSERT INTO ${t} (${c.map((x) => `"${x}"`).join(', ')}) VALUES (${c.map(() => '?').join(', ')})`;
    for (const r of rows) db.run(sql, ...r.map((v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v)));
  }
}
