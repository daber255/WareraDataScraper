import type { APIClient } from '@wareraprojects/api';
import type Database from 'better-sqlite3';
import type { ScraperDefinition } from './base.js';
import { storeSnapshot, startScrapeRun, completeScrapeRun, upsertCompany, upsertCompanyWorker, log, elapsed, pct } from './base.js';

const BATCH_SIZE = 50;

async function getCompanyIds(client: APIClient): Promise<string[]> {
  const ids: string[] = [];

  const result: any = await client.company.getCompanies({
    perPage: 100,
    autoPaginate: true,
  });

  for await (const page of result) {
    ids.push(...page.items);
  }

  return ids;
}

async function processCompany(
  client: APIClient,
  db: Database.Database,
  id: string,
): Promise<number> {
  let count = 0;

  try {
    const company: any = await client.company.getById({ companyId: id });
    let bonus: Record<string, unknown> | undefined;

    try {
      bonus = await client.company.getProductionBonus({ companyId: id }) as Record<string, unknown>;
      storeSnapshot(db, 'company.getProductionBonus', id, bonus);
    } catch {
      // bonus endpoint may fail
    }

    upsertCompany(db, company, bonus);
    storeSnapshot(db, 'company.getById', id, company);
    count++;

    if (company.workerCount > 0) {
      try {
        const workers: any = await client.worker.getWorkers({ companyId: id });
        if (workers.workers) {
          for (const worker of workers.workers) {
            upsertCompanyWorker(db, id, worker);
            count++;
          }
        }
      } catch {
        // workers endpoint may fail
      }
    }
  } catch {
    // company may have been deleted
  }

  return count;
}

async function scrapeAllCompanies(client: APIClient, db: Database.Database): Promise<number> {
  const t0 = Date.now();
  log('company', 'fetching company IDs from API...');
  const apiIds = new Set(await getCompanyIds(client));
  log('company', `fetched ${apiIds.size} IDs from API (${elapsed(t0)})`);

  let total = 0;
  const ids = [...apiIds];
  const totalBatches = Math.ceil(ids.length / BATCH_SIZE);

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const batch = ids.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(id => processCompany(client, db, id)),
    );
    total += results.reduce((a, b) => a + b, 0);

    if (batchNum % 20 === 0 || batchNum === 1 || batchNum === totalBatches) {
      log('company', `batch ${batchNum}/${totalBatches} – ${Math.min(i + BATCH_SIZE, ids.length)}/${ids.length} companies (${pct(Math.min(i + BATCH_SIZE, ids.length), ids.length)}) [${elapsed(t0)}]`);
    }
  }

  log('company', `done processing ${ids.length} companies (${elapsed(t0)})`);

  // Hard-delete stale companies (not in API anymore)
  const dbIds = (db.prepare('SELECT id FROM companies').all() as Array<{ id: string }>)
    .map(r => r.id)
    .filter(id => !apiIds.has(id));

  if (dbIds.length > 0) {
    const delWorker = db.prepare('DELETE FROM company_workers WHERE company_id = ?');
    const delCompany = db.prepare('DELETE FROM companies WHERE id = ?');
    const delTx = db.transaction(() => {
      for (const id of dbIds) {
        delWorker.run(id);
        delCompany.run(id);
      }
    });
    delTx();
    log('company', `deleted ${dbIds.length} stale companies`);
  }

  return total;
}

export const companyScraper: ScraperDefinition = {
  name: 'company',
  intervalMs: 12 * 60 * 60 * 1000,

  async execute(client: APIClient, db: Database.Database) {
    const runId = startScrapeRun(db, 'company');
    let count = 0;

    try {
      count += await scrapeAllCompanies(client, db);
      completeScrapeRun(db, runId, count);
    } catch (err) {
      completeScrapeRun(db, runId, count, String(err));
      throw err;
    }
  },
};
