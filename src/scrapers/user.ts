import type { APIClient } from '@wareraprojects/api';
import type Database from 'better-sqlite3';
import type { ScraperDefinition } from './base.js';
import { storeSnapshot, startScrapeRun, completeScrapeRun, upsertUser, insertUserHistory, log, elapsed, pct } from './base.js';

const BATCH = 50;

export const userScraper: ScraperDefinition = {
  name: 'user',
  intervalMs: 12 * 60 * 60 * 1000,

  async execute(client: APIClient, db: Database.Database) {
    const runId = startScrapeRun(db, 'user');
    let count = 0;
    const t0 = Date.now();
    const historyData: Record<string, unknown>[] = [];

    try {
      const countryRows = db.prepare('SELECT id, name FROM countries ORDER BY name').all() as { id: string; name: string }[];

      log('user', `processing ${countryRows.length} countries`);

      for (let ci = 0; ci < countryRows.length; ci++) {
        const country = countryRows[ci];

        try {
          const result: any = await client.user.getUsersByCountry({
            countryId: country.id,
            limit: 100,
            autoPaginate: true,
          });

          let userCount = 0;

          for await (const page of result) {
            const userIds: string[] = page.items.map((u: any) => u._id);
            userCount += userIds.length;
            const batches = Math.ceil(userIds.length / BATCH);

            for (let i = 0; i < userIds.length; i += BATCH) {
              const batchNum = Math.floor(i / BATCH) + 1;
              const batch = userIds.slice(i, i + BATCH);
              const userResults = await Promise.allSettled(
                batch.map((id: string) => client.user.getUserById({ userId: id }))
              );

              for (const r of userResults) {
                if (r.status === 'fulfilled') {
                  upsertUser(db, r.value);
                  storeSnapshot(db, 'user.getUserById', r.value._id as string, r.value);
                  historyData.push(r.value);
                  count++;
                }
              }

              if (batchNum % 5 === 0 || batchNum === 1 || batchNum === batches) {
                log('user', `  batch ${batchNum}/${batches} – ${pct(Math.min(i + BATCH, userIds.length), userIds.length)} [${elapsed(t0)}]`);
              }
            }
          }

          if (userCount > 0) {
            log('user', `country ${ci + 1}/${countryRows.length} – ${country.name} (${userCount} users)`);
          }
        } catch {
          // skip countries that fail
        }
      }

      log('user', `done – ${count} users processed (${elapsed(t0)})`);
      log('user', `writing ${historyData.length} history entries...`);
      const histT0 = Date.now();
      insertUserHistory(db, historyData, new Date().toISOString());
      log('user', `history written (${elapsed(histT0)})`);

      completeScrapeRun(db, runId, count);
    } catch (err) {
      completeScrapeRun(db, runId, count, String(err));
      throw err;
    }
  },
};
