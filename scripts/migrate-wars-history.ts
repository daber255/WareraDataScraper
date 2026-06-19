import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.SCRAPER_DATA_DIR || path.join(__dirname, '..', 'data'));
const dbPath = path.join(dataDir, 'warera.db');

function main() {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  console.log('Migrating database for wars & country_history...');

  db.exec(`
    CREATE TABLE IF NOT EXISTS wars (
      id TEXT PRIMARY KEY,
      is_active INTEGER DEFAULT 0,
      attacker_country TEXT,
      attacker_won_battles INTEGER DEFAULT 0,
      attacker_won_rounds INTEGER DEFAULT 0,
      attacker_damages REAL DEFAULT 0,
      defender_country TEXT,
      defender_won_battles INTEGER DEFAULT 0,
      defender_won_rounds INTEGER DEFAULT 0,
      defender_damages REAL DEFAULT 0,
      priority_country TEXT,
      priority_end_at TEXT,
      battles TEXT,
      created_at TEXT,
      updated_at TEXT,
      first_seen TEXT NOT NULL,
      last_updated TEXT NOT NULL
    )
  `);
  console.log('  + created wars table');

  db.exec(`
    CREATE TABLE IF NOT EXISTS country_history (
      fetched_at TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT,
      code TEXT,
      core_development REAL DEFAULT 0,
      current_development REAL DEFAULT 0,
      average_development REAL DEFAULT 0,
      money REAL DEFAULT 0,
      tax_income REAL DEFAULT 0,
      tax_market REAL DEFAULT 0,
      tax_self_work REAL DEFAULT 0,
      unrest_bar REAL DEFAULT 0,
      unrest_bar_max REAL DEFAULT 0,
      allies TEXT,
      enemy TEXT,
      wars_with TEXT,
      defensive_pacts TEXT,
      rankings TEXT,
      PRIMARY KEY (fetched_at, id)
    )
  `);
  console.log('  + created country_history table');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_country_history_id_fetched
    ON country_history(id, fetched_at)
  `);
  console.log('  + created country_history index');

  console.log('Done.');
  db.close();
}

main();
