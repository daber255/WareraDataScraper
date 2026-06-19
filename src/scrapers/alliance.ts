import type { APIClient } from '@wareraprojects/api';
import type Database from 'better-sqlite3';
import type { ScraperDefinition } from './base.js';
import { storeSnapshot, startScrapeRun, completeScrapeRun, log, elapsed } from './base.js';

export const allianceScraper: ScraperDefinition = {
  name: 'alliance',
  intervalMs: 6 * 60 * 60 * 1000,

  async execute(client: APIClient, db: Database.Database) {
    const runId = startScrapeRun(db, 'alliance');
    let count = 0;
    const t0 = Date.now();

    try {
      log('alliance', 'fetching all alliances...');
      const api = client as any;
      const result: any = await api.alliance.getManyPaginated({
        limit: 100,
        autoPaginate: true,
        maxPages: 20,
      });

      const upsert = db.prepare(`
        INSERT INTO alliances (
          id, name, scheme, map_accent, leader,
          member_countries, current_development, core_development, average_development,
          is_disbanded, disbanded_at,
          created_at, updated_at,
          first_seen, last_updated
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?,
          ?, ?,
          ?, ?
        )
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          scheme = excluded.scheme,
          map_accent = excluded.map_accent,
          leader = excluded.leader,
          member_countries = excluded.member_countries,
          current_development = excluded.current_development,
          core_development = excluded.core_development,
          average_development = excluded.average_development,
          is_disbanded = excluded.is_disbanded,
          disbanded_at = excluded.disbanded_at,
          updated_at = excluded.updated_at,
          last_updated = excluded.last_updated
      `);

      const now = new Date().toISOString();

      for await (const page of result) {
        for (const alliance of page.items) {
          const a = alliance as any;

          let detail: any = alliance;
          try {
            detail = await api.alliance.getById({ allianceId: a._id });
            count++;
          } catch {
            // use list data if getById fails
          }

          upsert.run(
            detail._id,
            detail.name ?? null,
            detail.scheme ?? null,
            detail.mapAccent ?? null,
            detail.leader ?? null,
            detail.memberCountries ? JSON.stringify(detail.memberCountries) : null,
            detail.currentDevelopment ?? 0,
            detail.coreDevelopment ?? 0,
            detail.averageDevelopment ?? 0,
            detail.isDisbanded ? 1 : 0,
            detail.disbandedAt ?? null,
            detail.createdAt ?? null,
            detail.updatedAt ?? null,
            now,
            now,
          );

          storeSnapshot(db, 'alliance.getById', detail._id, detail);
          count++;
        }
      }

      log('alliance', `done – ${count} items (${elapsed(t0)})`);
      completeScrapeRun(db, runId, count);
    } catch (err) {
      completeScrapeRun(db, runId, count, String(err));
      throw err;
    }
  },
};
