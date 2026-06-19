import { createAPIClient, type APIClient } from '@wareraprojects/api';
import type Database from 'better-sqlite3';
import type { Config } from './config.js';
import type { ScraperDefinition } from './scrapers/base.js';
import { countryScraper } from './scrapers/country.js';
import { eventScraper } from './scrapers/event.js';
import { battleScraper } from './scrapers/battle.js';
import { companyScraper } from './scrapers/company.js';
import { userScraper } from './scrapers/user.js';
import { rankingScraper } from './scrapers/ranking.js';
import { itemPriceScraper } from './scrapers/itemPrice.js';
import { muScraper } from './scrapers/mu.js';
import { donationScraper } from './scrapers/donation.js';
import { partyScraper } from './scrapers/party.js';
import { regionScraper } from './scrapers/region.js';
import { miscScraper } from './scrapers/misc.js';
import { allianceScraper } from './scrapers/alliance.js';
import { warScraper } from './scrapers/war.js';
import { getDb } from './db/connection.js';
import { execSync } from 'node:child_process';

export const ALL_SCRAPERS: ScraperDefinition[] = [
  countryScraper,
  eventScraper,
  battleScraper,
  companyScraper,
  userScraper,
  rankingScraper,
  itemPriceScraper,
  muScraper,
  donationScraper,
  partyScraper,
  regionScraper,
  miscScraper,
  allianceScraper,
  warScraper,
];

interface ScraperInstance {
  definition: ScraperDefinition;
  lastRun: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export async function runOnce(cfg: Config, all?: boolean) {
  const db = getDb(cfg);
  const client = createAPIClient({ apiKey: cfg.apiKey });

  const scrapers = all ? ALL_SCRAPERS : [
    eventScraper,
    battleScraper,
    itemPriceScraper,
  ];

  for (const scraper of scrapers) {
    const label = `[${scraper.name}]`;
    console.log(`${label} starting...`);
    try {
      await scraper.execute(client, db);
      console.log(`${label} done`);
    } catch (err) {
      console.error(`${label} failed:`, err);
    }
  }
}

export async function runAll(cfg: Config, client: APIClient, db: Database.Database) {
  for (const scraper of ALL_SCRAPERS) {
    const label = `[${scraper.name}]`;
    console.log(`${label} starting...`);
    try {
      await scraper.execute(client, db);
      console.log(`${label} done`);
    } catch (err) {
      console.error(`${label} failed:`, err);
    }
  }
}

function exportAndDeploy(cfg: Config) {
  try {
    console.log('[deploy] Exporting pages data...');
    execSync('npm run export:pages 2>&1', { stdio: 'inherit', cwd: cfg.projectRoot });

    console.log('[deploy] Committing and pushing...');
    execSync(
      `git -C ${cfg.projectRoot} add docs/data/alliances.json && \
       (git -C ${cfg.projectRoot} diff --cached --quiet || \
       (git -C ${cfg.projectRoot} commit -m "auto: update pages data" && \
        git -C ${cfg.projectRoot} push origin main))`,
      { stdio: 'inherit' },
    );
  } catch (err) {
    console.error('[deploy] failed:', err);
  }
}

export function startScheduler(cfg: Config) {
  const db = getDb(cfg);
  const client = createAPIClient({
    apiKey: cfg.apiKey,
    rateLimit: 500,
  });

  const instances: ScraperInstance[] = ALL_SCRAPERS.map(definition => ({
    definition,
    lastRun: 0,
    timer: null,
  }));

  async function runScraper(inst: ScraperInstance) {
    const label = `[${inst.definition.name}]`;
    console.log(`${label} starting...`);
    try {
      await inst.definition.execute(client, db);
      console.log(`${label} done`);

      if (inst.definition.name === 'user') {
        exportAndDeploy(cfg);
      }
    } catch (err) {
      console.error(`${label} failed:`, err);
    }
    inst.lastRun = Date.now();
    scheduleNext(inst);
  }

  function scheduleNext(inst: ScraperInstance) {
    let delay = inst.definition.intervalMs;

    if (inst.definition.scheduleHours?.length) {
      const now = new Date();
      const currentHour = now.getHours();
      const hrs = inst.definition.scheduleHours.sort((a, b) => a - b);

      const next = hrs.find(h => h > currentHour) ?? hrs[0];
      const nextDate = new Date(now);
      if (next <= currentHour) nextDate.setDate(nextDate.getDate() + 1);
      nextDate.setHours(next, 0, 0, 0);

      delay = Math.max(0, nextDate.getTime() - now.getTime());
    }

    inst.timer = setTimeout(() => runScraper(inst), delay);
  }

  // Initial full scrape
  console.log('Initial full scrape starting...');
  runAll(cfg, client, db).then(() => {
    console.log('Initial full scrape complete. Starting scheduler...');
    // Run export after initial scrape too
    exportAndDeploy(cfg);
    for (const inst of instances) {
      scheduleNext(inst);
    }
  });

  // Graceful shutdown
  function shutdown() {
    console.log('\nShutting down...');
    for (const inst of instances) {
      if (inst.timer) clearTimeout(inst.timer);
    }
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
