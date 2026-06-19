import Database from 'better-sqlite3';
import type { Config } from '../config.js';
import { CREATE_TABLES } from './schema.js';

let db: Database.Database | null = null;

export function getDb(cfg: Config): Database.Database {
  if (db) return db;

  db = new Database(cfg.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  for (const sql of CREATE_TABLES) {
    db.exec(sql);
  }

  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
}
