import type { APIClient } from '@wareraprojects/api';
import type Database from 'better-sqlite3';
import type { ScraperDefinition } from './base.js';
import { storeSnapshot, startScrapeRun, completeScrapeRun, log, elapsed } from './base.js';

export const warScraper: ScraperDefinition = {
  name: 'war',
  intervalMs: 6 * 60 * 60 * 1000,

  async execute(client: APIClient, db: Database.Database) {
    const runId = startScrapeRun(db, 'war');
    let count = 0;
    const t0 = Date.now();

    try {
      // Collect war IDs from battles table
      const fromBattles = db.prepare(
        `SELECT DISTINCT war_id FROM battles WHERE war_id IS NOT NULL AND war_id != ''`
      ).all() as Array<{ war_id: string }>;

      // Also get previously active wars
      const fromWars = db.prepare(
        `SELECT id FROM wars WHERE is_active = 1`
      ).all() as Array<{ id: string }>;

      const warIds = new Set<string>();
      for (const r of fromBattles) if (r.war_id) warIds.add(r.war_id);
      for (const r of fromWars) if (r.id) warIds.add(r.id);

      const ids = [...warIds];
      log('war', `found ${ids.length} war(s) to check`);

      const api = client as any;
      const upsert = db.prepare(`
        INSERT INTO wars (
          id, is_active,
          attacker_country, attacker_won_battles, attacker_won_rounds, attacker_damages,
          defender_country, defender_won_battles, defender_won_rounds, defender_damages,
          priority_country, priority_end_at, battles,
          created_at, updated_at,
          first_seen, last_updated
        ) VALUES (
          ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?,
          ?, ?
        )
        ON CONFLICT(id) DO UPDATE SET
          is_active = excluded.is_active,
          attacker_country = excluded.attacker_country,
          attacker_won_battles = excluded.attacker_won_battles,
          attacker_won_rounds = excluded.attacker_won_rounds,
          attacker_damages = excluded.attacker_damages,
          defender_country = excluded.defender_country,
          defender_won_battles = excluded.defender_won_battles,
          defender_won_rounds = excluded.defender_won_rounds,
          defender_damages = excluded.defender_damages,
          priority_country = excluded.priority_country,
          priority_end_at = excluded.priority_end_at,
          battles = excluded.battles,
          updated_at = excluded.updated_at,
          last_updated = excluded.last_updated
      `);

      const now = new Date().toISOString();

      for (let i = 0; i < ids.length; i++) {
        const warId = ids[i];

        try {
          const w = await api.war.getById({ warId });

          const att = w.attacker || {};
          const def = w.defender || {};

          upsert.run(
            w._id,
            w.isActive ? 1 : 0,

            att.country ?? null,
            att.wonBattlesCount ?? 0,
            att.wonRoundsCount ?? 0,
            att.damages ?? 0,

            def.country ?? null,
            def.wonBattlesCount ?? 0,
            def.wonRoundsCount ?? 0,
            def.damages ?? 0,

            w.priority ?? null,
            w.priorityEndAt ?? null,
            w.battles ? JSON.stringify(w.battles) : null,

            w.createdAt ?? null,
            w.updatedAt ?? null,

            now,
            now,
          );

          storeSnapshot(db, 'war.getById', w._id, w);
          count++;
        } catch {
          db.prepare('UPDATE wars SET is_active = 0, last_updated = ? WHERE id = ?').run(now, warId);
        }

        if ((i + 1) % 20 === 0 || i + 1 === ids.length) {
          log('war', `${i + 1}/${ids.length} [${elapsed(t0)}]`);
        }
      }

      log('war', `done – ${count} wars fetched (${elapsed(t0)})`);
      completeScrapeRun(db, runId, count);
    } catch (err) {
      completeScrapeRun(db, runId, count, String(err));
      throw err;
    }
  },
};
