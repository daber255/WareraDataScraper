import type { APIClient } from '@wareraprojects/api';
import type Database from 'better-sqlite3';
import type { ScraperDefinition } from './base.js';
import { storeSnapshot, startScrapeRun, completeScrapeRun, log, elapsed, pct } from './base.js';

export const partyScraper: ScraperDefinition = {
  name: 'party',
  intervalMs: 60 * 60 * 1000,

  async execute(client: APIClient, db: Database.Database) {
    const runId = startScrapeRun(db, 'party');
    let count = 0;
    const t0 = Date.now();

    try {
      const countries = db.prepare('SELECT id FROM countries').all() as Array<{ id: string }>;
      log('party', `processing ${countries.length} countries`);

      const upsert = db.prepare(`
        INSERT INTO parties (
          id, name, country_id, region, description,
          leader, council_members, members, treasurer, primary_winner,
          avatar_url,
          ethics_militarism, ethics_isolationism, ethics_imperialism, ethics_industrialism, ethics_unethical,
          created_at, updated_at,
          first_seen, last_updated
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?,
          ?, ?, ?, ?, ?,
          ?, ?,
          ?, ?
        )
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          country_id = excluded.country_id,
          region = excluded.region,
          description = excluded.description,
          leader = excluded.leader,
          council_members = excluded.council_members,
          members = excluded.members,
          treasurer = excluded.treasurer,
          primary_winner = excluded.primary_winner,
          avatar_url = excluded.avatar_url,
          ethics_militarism = excluded.ethics_militarism,
          ethics_isolationism = excluded.ethics_isolationism,
          ethics_imperialism = excluded.ethics_imperialism,
          ethics_industrialism = excluded.ethics_industrialism,
          ethics_unethical = excluded.ethics_unethical,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          last_updated = excluded.last_updated
      `);

      for (let ci = 0; ci < countries.length; ci++) {
        const { id: countryId } = countries[ci];
        const cName = (db.prepare('SELECT name FROM countries WHERE id = ?').get(countryId) as { name: string } | undefined)?.name ?? countryId;
        let done = false;

        const result: any = await client.party.getManyPaginated({
          countryId,
          limit: 100,
          autoPaginate: true,
        });

        let partyCount = 0;
        for await (const page of result) {
          if (done) break;
          for (const party of page.items) {
            const now = new Date().toISOString();
            const e = (party.ethics || {}) as Record<string, unknown>;

            upsert.run(
              party._id,
              party.name,
              party.country,
              party.region ?? null,
              party.description ?? null,
              party.leader ?? null,
              party.councilMembers ? JSON.stringify(party.councilMembers) : null,
              party.members ? JSON.stringify(party.members) : null,
              party.treasurer ?? null,
              party.primaryWinner ?? null,
              party.avatarUrl ?? null,

              e.militarism ?? 0,
              e.isolationism ?? 0,
              e.imperialism ?? 0,
              e.industrialism ?? 0,
              e.unethical ? 1 : 0,

              party.createdAt ?? null,
              party.updatedAt ?? null,

              now,
              now,
            );
            storeSnapshot(db, 'party.getManyPaginated', party._id, party);
            partyCount++;
            count++;
          }
        }

        if ((ci + 1) % 20 === 0 || ci + 1 === countries.length) {
          log('party', `country ${ci + 1}/${countries.length} – ${cName} (${partyCount} parties) [${elapsed(t0)}]`);
        }
      }

      log('party', `done – ${count} parties (${elapsed(t0)})`);
      completeScrapeRun(db, runId, count);
    } catch (err) {
      completeScrapeRun(db, runId, count, String(err));
      throw err;
    }
  },
};
