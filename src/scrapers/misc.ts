import type { APIClient } from '@wareraprojects/api';
import type Database from 'better-sqlite3';
import type { ScraperDefinition } from './base.js';
import { storeSnapshot, startScrapeRun, completeScrapeRun, log, elapsed } from './base.js';

async function scrapeGameConfig(client: APIClient, db: Database.Database): Promise<number> {
  let count = 0;

  try {
    const dates = await client.gameConfig.getDates();
    storeSnapshot(db, 'gameConfig.getDates', null, dates);
    count++;
  } catch { /* ignore */ }

  try {
    const config = await client.gameConfig.getGameConfig();
    storeSnapshot(db, 'gameConfig.getGameConfig', null, config);
    count++;
  } catch { /* ignore */ }

  return count;
}

async function scrapeArticles(client: APIClient, db: Database.Database): Promise<number> {
  let count = 0;

  try {
    const result: any = await client.article.getArticlesPaginated({
      type: 'last',
      limit: 50,
      autoPaginate: true,
      maxPages: 10,
    });

    let pageNum = 0;
    for await (const page of result) {
      pageNum++;
      for (const article of page.items) {
        storeSnapshot(db, 'article.getArticlesPaginated', article._id as string, article);
        count++;
      }
    }
  } catch { /* ignore */ }

  return count;
}

async function scrapeTransactions(client: APIClient, db: Database.Database): Promise<number> {
  let count = 0;

  try {
    const result: any = await client.transaction.getPaginatedTransactions({
      limit: 100,
      autoPaginate: true,
      maxPages: 20,
    });

    let pageNum = 0;
    for await (const page of result) {
      pageNum++;
      for (const tx of page.items) {
        storeSnapshot(db, 'transaction.getPaginatedTransactions', tx._id as string, tx);
        count++;
      }
    }
  } catch { /* ignore */ }

  return count;
}

export const miscScraper: ScraperDefinition = {
  name: 'misc',
  intervalMs: 120 * 60 * 1000,

  async execute(client: APIClient, db: Database.Database) {
    const runId = startScrapeRun(db, 'misc');
    let count = 0;
    const t0 = Date.now();

    try {
      log('misc', 'fetching game config...');
      count += await scrapeGameConfig(client, db);
      log('misc', 'fetching articles...');
      count += await scrapeArticles(client, db);
      log('misc', 'fetching transactions...');
      count += await scrapeTransactions(client, db);
      log('misc', `done – ${count} items (${elapsed(t0)})`);
      completeScrapeRun(db, runId, count);
    } catch (err) {
      completeScrapeRun(db, runId, count, String(err));
      throw err;
    }
  },
};
