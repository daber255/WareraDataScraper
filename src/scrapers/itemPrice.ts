import type { APIClient } from '@wareraprojects/api';
import type Database from 'better-sqlite3';
import type { ScraperDefinition } from './base.js';
import { storeSnapshot, startScrapeRun, completeScrapeRun, log, elapsed } from './base.js';

const KNOWN_ITEMS = [
  'ammo', 'bread', 'case1', 'case2', 'coca', 'cocain', 'concrete',
  'cookedFish', 'fish', 'grain', 'heavyAmmo', 'iron', 'lead', 'lightAmmo',
  'limestone', 'livestock', 'oil', 'paper', 'petroleum', 'scraps',
  'steak', 'steel', 'wood',
] as const;

type ItemRow = Record<string, number | string> & { fetched_at: string };

function buildRow(prices: Record<string, number>, fetchedAt: string): ItemRow {
  const row: ItemRow = { fetched_at: fetchedAt };
  for (const item of KNOWN_ITEMS) {
    row[item] = prices[item] ?? 0;
  }

  for (const key of Object.keys(prices)) {
    if (!KNOWN_ITEMS.includes(key as any)) {
      throw new Error(
        `Unknown item '${key}' – run: ALTER TABLE item_prices ADD COLUMN ${key} REAL DEFAULT 0`
      );
    }
  }

  return row;
}

export const itemPriceScraper: ScraperDefinition = {
  name: 'itemPrice',
  intervalMs: 6 * 60 * 60 * 1000,

  async execute(client: APIClient, db: Database.Database) {
    const runId = startScrapeRun(db, 'itemPrice');
    const t0 = Date.now();

    try {
      log('itemPrice', 'fetching prices...');
      const result: Record<string, number> = await client.itemTrading.getPrices() as any;
      storeSnapshot(db, 'itemTrading.getPrices', null, result);

      const now = new Date().toISOString();
      const row = buildRow(result, now);

      const columns = ['fetched_at', ...KNOWN_ITEMS];
      const placeholders = columns.map(() => '?').join(', ');
      const sql = `INSERT OR REPLACE INTO item_prices (${columns.join(', ')}) VALUES (${placeholders})`;
      const stmt = db.prepare(sql);
      stmt.run(...columns.map(c => row[c]));

      const deleted = db.prepare(
        `DELETE FROM item_prices WHERE fetched_at < datetime('now', '-30 days')`
      ).run();
      if (deleted.changes > 0) {
        log('itemPrice', `cleaned ${deleted.changes} old entries`);
      }

      log('itemPrice', `done – ${result ? Object.keys(result).length : 0} prices (${elapsed(t0)})`);
      completeScrapeRun(db, runId, 1);
    } catch (err) {
      completeScrapeRun(db, runId, 0, String(err));
      throw err;
    }
  },
};
