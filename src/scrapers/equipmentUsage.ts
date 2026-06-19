import type { APIClient } from '@wareraprojects/api';
import type Database from 'better-sqlite3';
import type { ScraperDefinition } from './base.js';
import { storeSnapshot, upsertEquipmentUsage, startScrapeRun, completeScrapeRun, log, elapsed } from './base.js';

export const equipmentUsageScraper: ScraperDefinition = {
  name: 'equipmentUsage',
  intervalMs: 60 * 60 * 1000,

  async execute(client: APIClient, db: Database.Database) {
    const runId = startScrapeRun(db, 'equipmentUsage');
    let count = 0;
    const t0 = Date.now();

    try {
      const latestRow = db.prepare('SELECT MAX(updated_at) AS max_updated FROM equipment_usage').get() as { max_updated: string | null } | undefined;
      const cursorEnd = latestRow?.max_updated ? new Date(latestRow.max_updated) : undefined;
      const isFirstRun = !cursorEnd;

      const options: Record<string, unknown> = {
        limit: 100,
        autoPaginate: true,
      };

      if (isFirstRun) {
        options.maxPages = 50;
        log('equipmentUsage', 'first run – scraping up to 50 pages');
      } else {
        options.cursorEnd = cursorEnd;
        log('equipmentUsage', `delta scrape – cursorEnd=${cursorEnd?.toISOString()}`);
      }

      const result: any = await client.transaction.getPaginatedTransactions(options);

      let pageNum = 0;
      for await (const page of result) {
        pageNum++;
        for (const tx of page.items) {
          const item = tx.item as Record<string, unknown> | undefined;
          if (item && (item.state as number) === 0) {
            storeSnapshot(db, 'transaction.getPaginatedTransactions', tx._id as string, tx);
            upsertEquipmentUsage(db, tx);
            count++;
          }
        }
      }

      log('equipmentUsage', `done – ${count} used equipment items${isFirstRun ? '' : ' (delta)'} (${pageNum} pages, ${elapsed(t0)})`);
      completeScrapeRun(db, runId, count);
    } catch (err) {
      completeScrapeRun(db, runId, count, String(err));
      throw err;
    }
  },
};
