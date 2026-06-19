import { createAPIClient } from '@wareraprojects/api';
import { getDb } from './src/db/connection.js';
import { loadConfig } from './src/config.js';
import { partyScraper } from './src/scrapers/party.js';
import { regionScraper } from './src/scrapers/region.js';

const cfg = loadConfig();
const db = getDb(cfg);
const client = createAPIClient({ apiKey: cfg.apiKey });

// Wipe regions to avoid conflict with old INSERT-only data
db.exec('DELETE FROM regions');

console.log('[party] running...');
await partyScraper.execute(client, db);

console.log('[region] running...');
await regionScraper.execute(client, db);

console.log('done');
