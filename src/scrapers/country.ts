import type { APIClient } from '@wareraprojects/api';
import type Database from 'better-sqlite3';
import type { ScraperDefinition } from './base.js';
import { storeSnapshot, startScrapeRun, completeScrapeRun, upsertCountry, insertCountryHistory, log, elapsed, pct } from './base.js';

export const countryScraper: ScraperDefinition = {
  name: 'country',
  intervalMs: 30 * 60 * 1000,

  async execute(client: APIClient, db: Database.Database) {
    const runId = startScrapeRun(db, 'country');
    let count = 0;
    const t0 = Date.now();

    try {
      log('country', 'fetching all countries...');
      const countries = await client.country.getAllCountries() as unknown as Record<string, unknown>[];
      storeSnapshot(db, 'country.getAllCountries', null, countries);
      count += countries.length;
      log('country', `fetched ${countries.length} countries`);

      for (let i = 0; i < countries.length; i++) {
        const country = countries[i];
        upsertCountry(db, country);
        const cid = country._id as string;

        const gov = await client.government.getByCountryId({ countryId: cid });
        storeSnapshot(db, 'government.getByCountryId', cid, gov);
        count++;

        if ((i + 1) % 30 === 0 || i + 1 === countries.length) {
          log('country', `gov ${i + 1}/${countries.length} (${pct(i + 1, countries.length)}) [${elapsed(t0)}]`);
        }
      }

      log('country', `writing ${countries.length} history entries...`);
      insertCountryHistory(db, countries, new Date().toISOString());

      log('country', `done – ${count} items (${elapsed(t0)})`);
      completeScrapeRun(db, runId, count);
    } catch (err) {
      completeScrapeRun(db, runId, count, String(err));
      throw err;
    }
  },
};
