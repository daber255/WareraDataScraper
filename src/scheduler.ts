import { createAPIClient, type APIClient } from '@wareraprojects/api';
import Database from 'better-sqlite3';
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
import { equipmentUsageScraper } from './scrapers/equipmentUsage.js';
import { getDb, closeDb } from './db/connection.js';
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
  equipmentUsageScraper,
];

interface ScraperInstance {
  definition: ScraperDefinition;
  lastRun: number;
  timer: ReturnType<typeof setTimeout> | null;
}

function createClients(cfg: Config): APIClient[] {
  return cfg.apiKeys.map(key => createAPIClient({ apiKey: key, rateLimit: 500 }));
}

let clientIndex = 0;
function nextClient(clients: APIClient[]): APIClient {
  const client = clients[clientIndex % clients.length];
  clientIndex++;
  return client;
}

export async function runOnce(cfg: Config, all?: boolean) {
  const db = getDb(cfg);
  const clients = createClients(cfg);

  const scrapers = all ? ALL_SCRAPERS : [
    eventScraper,
    battleScraper,
    itemPriceScraper,
  ];

  for (const scraper of scrapers) {
    const label = `[${scraper.name}]`;
    console.log(`${label} starting...`);
    try {
      await scraper.execute(nextClient(clients), db);
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
  if (!cfg.gitHubToken) return; // Pi ohne Token → kein Deploy

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

async function generateBeerWarPng(cfg: Config) {
  try {
    console.log('[png] Generating B.E.E.R War Update PNG...');
    execSync('npm run report:beer-png 2>&1', { stdio: 'inherit', cwd: cfg.projectRoot });
    console.log('[png] Done');
  } catch (err) {
    console.error('[png] failed:', err);
  }
}

function checkIntegrity(cfg: Config) {
  for (const [label, p] of [['main', cfg.dbPath] as const, ['snapshots', cfg.snapshotsDbPath] as const]) {
    try {
      const d = new Database(p, { readonly: true });
      const r = d.prepare('PRAGMA integrity_check').get() as Record<string, string>;
      const ok = r && Object.values(r)[0] === 'ok';
      console.log(`[integrity] ${label} (${p}): ${ok ? 'OK' : 'CORRUPT: ' + JSON.stringify(r)}`);
      d.close();
    } catch (err) {
      console.error(`[integrity] ${label} check failed:`, err);
    }
  }
}

export function startScheduler(cfg: Config) {
  const db = getDb(cfg);
  const clients = createClients(cfg);

  const instances: ScraperInstance[] = ALL_SCRAPERS.map(definition => ({
    definition,
    lastRun: 0,
    timer: null,
  }));

  async function runScraper(inst: ScraperInstance) {
    const client = nextClient(clients);
    const label = `[${inst.definition.name}]`;
    console.log(`${label} starting...`);
    try {
      await inst.definition.execute(client, db);
      console.log(`${label} done`);

      if (inst.definition.name === 'user') {
        exportAndDeploy(cfg);
        const h = new Date().getUTCHours();
        if (h >= 0 && h <= 2) {
          await generateBeerWarPng(cfg);
        }
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
      const currentHour = now.getUTCHours();
      const hrs = inst.definition.scheduleHours.sort((a, b) => a - b);

      const next = hrs.find(h => h > currentHour) ?? hrs[0];
      const nextDate = new Date(now);
      if (next <= currentHour) nextDate.setUTCDate(nextDate.getUTCDate() + 1);
      nextDate.setUTCHours(next, 0, 0, 0);

      delay = Math.max(0, nextDate.getTime() - now.getTime());
    }

    inst.timer = setTimeout(() => runScraper(inst), delay);
  }

  // Initial integrity check at startup
  checkIntegrity(cfg);

  // Schedule daily integrity check (every 24h)
  const integrityInterval = setInterval(() => checkIntegrity(cfg), 24 * 60 * 60 * 1000);

  // Start scheduler immediately (no full scrape)
  console.log('Starting scheduler...');
  for (const inst of instances) {
    scheduleNext(inst);
  }

  // Graceful shutdown
  function shutdown() {
    console.log('\nShutting down...');
    for (const inst of instances) {
      if (inst.timer) clearTimeout(inst.timer);
    }
    clearInterval(integrityInterval);
    closeDb();
    setTimeout(() => process.exit(0), 5000);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
