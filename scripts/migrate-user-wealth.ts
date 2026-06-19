import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const dataDir = path.resolve(process.env.SCRAPER_DATA_DIR || path.join(ROOT, 'data'));
const dbPath = path.join(dataDir, 'warera.db');

const NEW_COLS = [
  { name: 'wealth_companies', type: 'REAL DEFAULT 0' },
  { name: 'wealth_items', type: 'REAL DEFAULT 0' },
  { name: 'wealth_money', type: 'REAL DEFAULT 0' },
  { name: 'wealth_equipments', type: 'REAL DEFAULT 0' },
  { name: 'wealth_weapons', type: 'REAL DEFAULT 0' },
];

function migrateTable(db: Database.Database, table: string) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  const existingNames = new Set(existing.map(r => r.name));

  for (const col of NEW_COLS) {
    if (!existingNames.has(col.name)) {
      const sql = `ALTER TABLE ${table} ADD COLUMN ${col.name} ${col.type}`;
      db.exec(sql);
      console.log(`  + ${table}.${col.name}`);
    } else {
      console.log(`  ~ ${table}.${col.name} already exists`);
    }
  }
}

function backfillFromSnapshots(db: Database.Database) {
  console.log('\nBackfilling wealth breakdown from user.getUserById snapshots...');
  const rows = db.prepare(
    `SELECT data FROM snapshots WHERE endpoint = 'user.getUserById' AND data LIKE '%"wealth"%'`,
  ).all() as { data: string }[];

  if (rows.length === 0) {
    console.log('  No snapshots with wealth data found (scraper needs to call getUserById first).');
    return;
  }

  const stmt = db.prepare(`
    UPDATE users SET
      wealth_companies = ?,
      wealth_items = ?,
      wealth_money = ?,
      wealth_equipments = ?,
      wealth_weapons = ?
    WHERE id = ?
  `);

  let updated = 0;
  for (const row of rows) {
    const d = JSON.parse(row.data);
    const w = d.wealth || {};
    if (typeof w === 'object') {
      stmt.run(
        w.companies ?? 0,
        w.items ?? 0,
        w.money ?? 0,
        w.equipments ?? 0,
        w.weapons ?? 0,
        d._id,
      );
      updated++;
    }
  }
  console.log(`  Updated ${updated} users from snapshots.`);
}

function main() {
  console.log('Migrating user wealth columns...\n');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  console.log('== users ==');
  migrateTable(db, 'users');
  console.log('\n== user_history ==');
  migrateTable(db, 'user_history');

  backfillFromSnapshots(db);

  db.close();
  console.log('\nDone.');
}

main();
