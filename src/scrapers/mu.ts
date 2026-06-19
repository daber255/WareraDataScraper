import type { APIClient } from '@wareraprojects/api';
import type Database from 'better-sqlite3';
import type { ScraperDefinition } from './base.js';
import { storeSnapshot, startScrapeRun, completeScrapeRun, upsertMilitaryUnit, log, elapsed, pct } from './base.js';

export const muScraper: ScraperDefinition = {
  name: 'mu',
  intervalMs: 60 * 60 * 1000,

  async execute(client: APIClient, db: Database.Database) {
    const runId = startScrapeRun(db, 'mu');
    let count = 0;
    const t0 = Date.now();

    try {
      log('mu', 'fetching military units...');

      const result: any = await client.mu.getManyPaginated({
        limit: 100,
        autoPaginate: true,
        maxPages: 100,
      });

      let pageNum = 0;
      for await (const page of result) {
        pageNum++;
        for (const mu of page.items) {
          upsertMilitaryUnit(db, mu);
          storeSnapshot(db, 'mu.getManyPaginated', mu._id as string, mu);
          count++;
        }
        log('mu', `page ${pageNum} – ${count} MUs so far [${elapsed(t0)}]`);
      }

      log('mu', `done – ${count} MUs (${elapsed(t0)})`);
      completeScrapeRun(db, runId, count);
    } catch (err) {
      completeScrapeRun(db, runId, count, String(err));
      throw err;
    }
  },
};
