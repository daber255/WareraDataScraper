import type { APIClient } from '@wareraprojects/api';
import type Database from 'better-sqlite3';
import type { ScraperDefinition } from './base.js';
import { storeSnapshot, startScrapeRun, completeScrapeRun, log, elapsed } from './base.js';

export const eventScraper: ScraperDefinition = {
  name: 'event',
  intervalMs: 5 * 60 * 1000,

  async execute(client: APIClient, db: Database.Database) {
    const runId = startScrapeRun(db, 'event');
    let count = 0;
    const t0 = Date.now();

    try {
      log('event', 'fetching events...');

      const result: any = await client.event.getEventsPaginated({
        limit: 100,
        autoPaginate: true,
        maxPages: 20,
      });

      for await (const page of result) {
        for (const event of page.items) {
          storeSnapshot(db, 'event.getEventsPaginated', event._id as string, event);
          count++;
        }
      }

      log('event', `done – ${count} events (${elapsed(t0)})`);
      completeScrapeRun(db, runId, count);
    } catch (err) {
      completeScrapeRun(db, runId, count, String(err));
      throw err;
    }
  },
};
