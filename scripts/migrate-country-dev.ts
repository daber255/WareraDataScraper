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

  console.log('Migrating countries table...');

  // Add new columns (IF NOT EXISTS makes them idempotent)
  const newCols = [
    'core_development REAL DEFAULT 0',
    'current_development REAL DEFAULT 0',
    'average_development REAL DEFAULT 0',
    'defensive_pacts TEXT',
    'non_aggression_until TEXT',
  ];

  for (const colDef of newCols) {
    const colName = colDef.split(' ')[0];
    try {
      db.exec(`ALTER TABLE countries ADD COLUMN ${colDef}`);
      console.log(`  + added column ${colName}`);
    } catch (e: any) {
      if (e.message.includes('duplicate column')) {
        console.log(`  ~ ${colName} already exists`);
      } else {
        throw e;
      }
    }
  }

  // Add parties column
  try {
    db.exec('ALTER TABLE parties ADD COLUMN ethics_unethical INTEGER DEFAULT 0');
    console.log('  + added parties.ethics_unethical');
  } catch (e: any) {
    if (e.message.includes('duplicate column')) {
      console.log('  ~ parties.ethics_unethical already exists');
    } else {
      throw e;
    }
  }

  // Create alliances table
  db.exec(`
    CREATE TABLE IF NOT EXISTS alliances (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      scheme TEXT,
      map_accent TEXT,
      leader TEXT,
      member_countries TEXT,
      current_development REAL DEFAULT 0,
      core_development REAL DEFAULT 0,
      average_development REAL DEFAULT 0,
      is_disbanded INTEGER DEFAULT 0,
      disbanded_at TEXT,
      created_at TEXT,
      updated_at TEXT,
      first_seen TEXT NOT NULL,
      last_updated TEXT NOT NULL
    )
  `);
  console.log('  + created alliances table');

  // Copy existing development values to new columns if development has data
  const result = db.prepare(`
    UPDATE countries
    SET core_development = development,
        current_development = development,
        average_development = development
    WHERE development IS NOT NULL AND development > 0
      AND (core_development IS NULL OR core_development = 0)
  `).run();
  console.log(`  copied development → core/current/average for ${result.changes} rows`);

  console.log('Done.');
  db.close();
}

main();
