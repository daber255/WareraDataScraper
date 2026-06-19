import type { APIClient } from '@wareraprojects/api';
import type Database from 'better-sqlite3';
import type { ScraperDefinition } from './base.js';
import { storeSnapshot, startScrapeRun, completeScrapeRun, log, elapsed, pct } from './base.js';

const RANKING_TYPES = [
  'weeklyCountryDamages',
  'weeklyCountryDamagesPerCitizen',
  'countryRegionDiff',
  'countryDevelopment',
  'countryActivePopulation',
  'countryDamages',
  'countryWealth',
  'countryProductionBonus',
  'countryBounty',
  'weeklyUserDamages',
  'userDamages',
  'userWealth',
  'userLevel',
  'userReferrals',
  'userSubscribers',
  'userTerrain',
  'userPremiumMonths',
  'userPremiumGifts',
  'userCasesOpened',
  'userGemsPurchased',
  'userBounty',
  'muWeeklyDamages',
  'muDamages',
  'muTerrain',
  'muWealth',
  'muBounty',
  'muReputation',
] as const;

export const rankingScraper: ScraperDefinition = {
  name: 'ranking',
  intervalMs: 60 * 60 * 1000,

  async execute(client: APIClient, db: Database.Database) {
    const runId = startScrapeRun(db, 'ranking');
    let count = 0;
    const t0 = Date.now();

    try {
      log('ranking', `fetching ${RANKING_TYPES.length} ranking types...`);

      for (let i = 0; i < RANKING_TYPES.length; i++) {
        const rankingType = RANKING_TYPES[i];
        try {
          const data = await client.ranking.getRanking({ rankingType });
          storeSnapshot(db, 'ranking.getRanking', rankingType, data);
          count++;
        } catch {
          // some ranking types may not be available
        }

        if ((i + 1) % 5 === 0 || i + 1 === RANKING_TYPES.length) {
          log('ranking', `${i + 1}/${RANKING_TYPES.length} (${pct(i + 1, RANKING_TYPES.length)}) [${elapsed(t0)}]`);
        }
      }

      log('ranking', `done – ${count} rankings (${elapsed(t0)})`);
      completeScrapeRun(db, runId, count);
    } catch (err) {
      completeScrapeRun(db, runId, count, String(err));
      throw err;
    }
  },
};
