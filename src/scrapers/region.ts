import type { APIClient } from '@wareraprojects/api';
import type Database from 'better-sqlite3';
import type { ScraperDefinition } from './base.js';
import { storeSnapshot, startScrapeRun, completeScrapeRun, log, elapsed } from './base.js';

export const regionScraper: ScraperDefinition = {
  name: 'region',
  intervalMs: 60 * 60 * 1000,

  async execute(client: APIClient, db: Database.Database) {
    const runId = startScrapeRun(db, 'region');
    let count = 0;
    const t0 = Date.now();

    try {
      log('region', 'fetching all regions...');
      const result: any = await client.region.getRegionsObject();
      storeSnapshot(db, 'region.getRegionsObject', null, result);

      const sql = 'INSERT OR REPLACE INTO regions (' +
        'id,name,code,country_id,country_code,' +
        'biome,climate,is_capital,is_linked_to_capital,has_coast,' +
        'development,base_development,resistance,resistance_max,' +
        'initial_country,main_city,strategic_resource,active_battle_id,' +
        'neighbors,position,stats,deposit,active_upgrade_levels,upgrades,' +
        'last_battle_ended_at,last_resistance_contribution_at,last_revolt_ended_at,' +
        'first_seen,last_updated' +
        ') VALUES (' +
        '?,?,?,?,?,' +
        '?,?,?,?,?,' +
        '?,?,?,?,' +
        '?,?,?,?,' +
        '?,?,?,?,?,?,' +
        '?,?,?,' +
        '?,?' +
        ')';
      const upsert = db.prepare(sql);

      const now = new Date().toISOString();

      for (const [id, r] of Object.entries(result)) {
        const region = r as any;

        upsert.run(
          region._id ?? id,
          region.name,
          region.code ?? null,
          region.country ?? null,
          region.countryCode ?? null,

          region.biome ?? null,
          region.climate ?? null,
          region.isCapital ? 1 : 0,
          region.isLinkedToCapital ? 1 : 0,
          region.hasCoast ? 1 : 0,

          region.development ?? 0,
          region.baseDevelopment ?? 0,
          region.resistance ?? 0,
          region.resistanceMax ?? 0,

          region.initialCountry ?? null,
          region.mainCity ?? null,
          region.strategicResource ?? null,
          region.activeBattle ? (typeof region.activeBattle === 'object' ? JSON.stringify(region.activeBattle) : region.activeBattle) : null,

          region.neighbors ? JSON.stringify(region.neighbors) : null,
          region.position ? JSON.stringify(region.position) : null,
          region.stats ? JSON.stringify(region.stats) : null,
          region.deposit ? JSON.stringify(region.deposit) : null,
          region.activeUpgradeLevels ? JSON.stringify(region.activeUpgradeLevels) : null,
          region.upgradesV2 ? JSON.stringify(region.upgradesV2) : null,

          region.lastBattleEndedAt ?? null,
          region.lastResistanceContributionAt ?? null,
          region.lastRevoltEndedAt ?? null,

          now,
          now,
        );
        count++;
      }

      log('region', `done – ${count} regions (${elapsed(t0)})`);
      completeScrapeRun(db, runId, count);
    } catch (err) {
      completeScrapeRun(db, runId, count, String(err));
      throw err;
    }
  },
};
