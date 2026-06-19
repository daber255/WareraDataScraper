import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAPIClient } from '@wareraprojects/api';
import { loadConfig } from '../src/config.js';
import { upsertUser, storeSnapshot } from '../src/scrapers/base.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const BATCH = 50;

async function main() {
  const cfg = loadConfig();

  const dataDir = path.resolve(process.env.SCRAPER_DATA_DIR || path.join(ROOT, 'data'));
  const dbPath = path.join(dataDir, 'warera.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  const party = db
    .prepare("SELECT id, name, members FROM parties WHERE name LIKE '%ADAV%'")
    .get() as { id: string; name: string; members: string } | undefined;

  if (!party) {
    console.error('ADAV party not found in DB');
    process.exit(1);
  }

  const allMemberIds: string[] = JSON.parse(party.members);
  console.log(`ADAV: ${party.name}`);
  console.log(`Total members: ${allMemberIds.length}`);

  const existing = db
    .prepare(`SELECT id FROM users WHERE id IN (${allMemberIds.map(() => '?').join(',')})`)
    .all(...allMemberIds) as { id: string }[];

  const existingSet = new Set(existing.map(r => r.id));
  const missing = allMemberIds.filter(id => !existingSet.has(id));

  console.log(`Already in DB: ${existing.length}`);
  console.log(`Missing from DB: ${missing.length}`);

  if (missing.length === 0) {
    console.log('All members already present – nothing to fetch.');
    db.close();
    return;
  }

  const client = createAPIClient({ apiKey: cfg.apiKey });

  let fetched = 0;
  let errors = 0;

  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH);
    const batchNum = Math.floor(i / BATCH) + 1;
    const totalBatches = Math.ceil(missing.length / BATCH);

    console.log(`\nBatch ${batchNum}/${totalBatches} (${batch.length} users)...`);

    const results = await Promise.allSettled(
      batch.map(id => client.user.getUserLite({ userId: id })),
    );

    for (const r of results) {
      if (r.status === 'fulfilled') {
        upsertUser(db, r.value);
        storeSnapshot(db, 'user.getUserLite', r.value._id as string, r.value);
        fetched++;
      } else {
        console.error(`  Error: ${r.reason}`);
        errors++;
      }
    }

    console.log(`  → ${fetched} fetched, ${errors} errors so far`);
  }

  console.log(`\nDone: ${fetched} users fetched, ${errors} errors`);
  db.close();
}

await main();
