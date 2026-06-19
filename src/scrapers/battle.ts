import type { APIClient } from '@wareraprojects/api';
import type Database from 'better-sqlite3';
import type { ScraperDefinition } from './base.js';
import { storeSnapshot, startScrapeRun, completeScrapeRun, upsertBattle, upsertMercenaryContract, log, elapsed } from './base.js';

async function scrapeActiveBattles(client: APIClient, db: Database.Database): Promise<number> {
  let count = 0;
  const t0 = Date.now();
  log('battle', 'fetching active battles...');

  // Track currently active battles to detect finished ones
  const activeBefore = new Set(
    (db.prepare('SELECT id FROM battles WHERE is_active = 1').all() as Array<{ id: string }>).map(r => r.id),
  );

  const result: any = await client.battle.getBattles({
    isActive: true,
    limit: 100,
    autoPaginate: true,
    maxPages: 10,
  });

  const activeAfter = new Set<string>();

  for await (const page of result) {
    for (const battle of page.items) {
      const id = battle._id as string;
      activeAfter.add(id);

      upsertBattle(db, battle);
      storeSnapshot(db, 'battle.getBattles', id, battle, { isActive: true });
      count++;

      try {
        const live = await client.battle.getLiveBattleData({ battleId: id });
        storeSnapshot(db, 'battle.getLiveBattleData', id, live);
        count++;
      } catch {
        // live data may not be available for all battles
      }

      count += await scrapeBattleContracts(client, db, id);
    }
  }

  log('battle', `found ${activeAfter.size} active battles (${elapsed(t0)})`);

  // Battles that were active but are no longer in the API response -> finished
  const finishedIds = [...activeBefore].filter(id => !activeAfter.has(id));

  if (finishedIds.length > 0) {
    log('battle', `${finishedIds.length} battle(s) finished, fetching final data...`);
  }

  for (const id of finishedIds) {
    try {
      const finished: any = await client.battle.getById({ battleId: id });
      upsertBattle(db, finished);
      storeSnapshot(db, 'battle.getBattles', id, finished, { isActive: false });
      count++;
    } catch {
      // getById may fail if the battle was deleted; just mark inactive
      db.prepare('UPDATE battles SET is_active = 0, last_updated = ? WHERE id = ?')
        .run(new Date().toISOString(), id);
    }

    count += await scrapeBattleContracts(client, db, id);
  }

  if (finishedIds.length > 0) {
    log('battle', `finished battles processed (${elapsed(t0)})`);
  }

  return count;
}

async function scrapeBattleRankings(client: APIClient, db: Database.Database): Promise<number> {
  let count = 0;
  const t0 = Date.now();
  log('battle', 'fetching active battle rankings...');

  const active: any = await client.battle.getBattles({
    isActive: true,
    limit: 20,
  });

  const battles = active.items ?? active;
  let totalCombos = 0;

  for (const battle of battles) {
    const bid = (battle as Record<string, unknown>)._id as string;
    const sides = ['attacker', 'defender', 'merged'] as const;
    const types = ['damage', 'points', 'money'] as const;
    const entities = ['user', 'country', 'mu'] as const;
    totalCombos += sides.length * types.length * entities.length;
  }

  let comboNum = 0;

  for (const battle of battles) {
    const bid = (battle as Record<string, unknown>)._id as string;
    const sides = ['attacker', 'defender', 'merged'] as const;
    const types = ['damage', 'points', 'money'] as const;
    const entities = ['user', 'country', 'mu'] as const;

    for (const side of sides) {
      for (const dataType of types) {
        for (const entityType of entities) {
          comboNum++;
          try {
            const ranking = await client.battleRanking.getRanking({
              battleId: bid,
              dataType,
              type: entityType,
              side,
            });
            const key = `battleRanking.getRanking:${bid}:${dataType}:${entityType}:${side}`;
            storeSnapshot(db, key, null, ranking, { battleId: bid, dataType, entityType, side });
            count++;
          } catch {
            // some combos may not have data
          }

          if (comboNum % 10 === 0 || comboNum === totalCombos) {
            log('battle', `  rankings ${comboNum}/${totalCombos} – ${dataType}:${entityType}:${side}`);
          }
        }
      }
    }
  }

  log('battle', `rankings done – ${count} snapshots (${elapsed(t0)})`);
  return count;
}

async function scrapeBattleContracts(client: APIClient, db: Database.Database, battleId: string): Promise<number> {
  let count = 0;

  try {
    const result: any = await client.mercenaryContractAuction.getPaginatedAuctions({
      battleId,
      status: 'won',
      limit: 100,
      autoPaginate: true,
    });

    for await (const page of result) {
      for (const contract of page.items) {
        storeSnapshot(db, 'mercenaryContractAuction.getPaginatedAuctions', contract._id as string, contract);
        upsertMercenaryContract(db, contract);
        count++;
      }
    }
  } catch {
    // contract data may not be available for all battles
  }

  return count;
}

export const battleScraper: ScraperDefinition = {
  name: 'battle',
  intervalMs: 5 * 60 * 1000,

  async execute(client: APIClient, db: Database.Database) {
    const runId = startScrapeRun(db, 'battle');
    let count = 0;
    const t0 = Date.now();

    try {
      count += await scrapeActiveBattles(client, db);
      count += await scrapeBattleRankings(client, db);
      log('battle', `done – ${count} items (${elapsed(t0)})`);
      completeScrapeRun(db, runId, count);
    } catch (err) {
      completeScrapeRun(db, runId, count, String(err));
      throw err;
    }
  },
};
