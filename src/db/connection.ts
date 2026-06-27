import Database from 'better-sqlite3';
import type { Config } from '../config.js';
import { CREATE_TABLES } from './schema.js';

let db: Database.Database | null = null;

export function getDb(cfg: Config): Database.Database {
  if (db) return db;

  db = new Database(cfg.dbPath);
  db.pragma('busy_timeout = 5000');
  try {
    db.pragma('journal_mode = WAL');
  } catch {
    try {
      db.pragma('journal_mode = OFF');
    } catch {
      // best-effort
    }
  }
  try {
    db.pragma('synchronous = FULL');
  } catch {
    // best-effort
  }
  db.pragma('foreign_keys = ON');

  // Create all tables (snapshots live in main DB alongside normalized tables)
  for (const sql of CREATE_TABLES) {
    const trimmed = sql.trim();
    db.exec(trimmed);
  }

  return db;
}

export function closeDb(): void {
  if (!db) return;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // best-effort
  }
  try {
    db.close();
  } catch {
    // best-effort
  }
  db = null;
}
