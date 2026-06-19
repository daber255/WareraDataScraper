import type { APIClient } from '@wareraprojects/api';
import type Database from 'better-sqlite3';
import type { ScraperDefinition } from './base.js';
import { storeSnapshot, startScrapeRun, completeScrapeRun, log, elapsed, pct } from './base.js';

export const donationScraper: ScraperDefinition = {
  name: 'donation',
  intervalMs: 30 * 60 * 1000,

  async execute(client: APIClient, db: Database.Database) {
    const runId = startScrapeRun(db, 'donation');
    let count = 0;
    const t0 = Date.now();

    try {
      const isFirstRun = (db.prepare('SELECT COUNT(*) as cnt FROM donations').get() as { cnt: number }).cnt === 0;
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

      const countries = db.prepare('SELECT id FROM countries').all() as Array<{ id: string }>;
      log('donation', `processing ${countries.length} countries${isFirstRun ? ' (first run, 10-day cutoff)' : ''}`);

      const insert = db.prepare(`
        INSERT OR IGNORE INTO donations (id, user_id, country_id, mu_id, party_id, amount, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (let ci = 0; ci < countries.length; ci++) {
        const { id: countryId } = countries[ci];
        const cName = (db.prepare('SELECT name FROM countries WHERE id = ?').get(countryId) as { name: string } | undefined)?.name ?? countryId;
        let done = false;

        const result: any = await client.donation.getManyPaginated({
          countryId,
          limit: 100,
          autoPaginate: true,
        });

        let pageCount = 0;
        for await (const page of result) {
          if (done) break;
          pageCount++;
          for (const item of page.items) {
            if (isFirstRun && item.createdAt < tenDaysAgo) {
              done = true;
              break;
            }

            const info = insert.run(
              item._id,
              item.userId,
              item.countryId ?? null,
              item.muId ?? null,
              item.partyId ?? null,
              item.amount,
              item.createdAt,
            );
            storeSnapshot(db, 'donation.getManyPaginated', item._id, item);

            if (!isFirstRun && info.changes === 0) {
              done = true;
              break;
            }

            count++;
          }
        }

        if ((ci + 1) % 20 === 0 || ci + 1 === countries.length) {
          log('donation', `country ${ci + 1}/${countries.length} – ${cName} (${pageCount} pages, ${count} donations) [${elapsed(t0)}]`);
        }
      }

      log('donation', `done – ${count} donations (${elapsed(t0)})`);
      completeScrapeRun(db, runId, count);
    } catch (err) {
      completeScrapeRun(db, runId, count, String(err));
      throw err;
    }
  },
};
