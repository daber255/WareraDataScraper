import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadConfig() {
  const apiKey = process.env.WARERA_API_KEY;
  if (!apiKey) {
    console.error('WARERA_API_KEY is required in .env');
    process.exit(1);
  }

  const apiKeys = [
    apiKey,
    ...['_2', '_3', '_4']
      .map(suffix => process.env[`WARERA_API_KEY${suffix}`])
      .filter((k): k is string => !!k),
  ];

  const projectRoot = path.resolve(__dirname, '..');
  const dataDir = path.resolve(process.env.SCRAPER_DATA_DIR || path.join(projectRoot, 'data'));
  const dbPath = path.join(dataDir, 'warera.db');
  const snapshotsDbPath = path.join(dataDir, 'warera-snapshots.db');

  return {
    apiKey,
    apiKeys,
    gitHubToken: process.env.GITHUB_TOKEN,
    projectRoot,
    dataDir,
    dbPath,
    snapshotsDbPath,

    intervals: {
      FAST: 5 * 60 * 1000,
      MEDIUM: 30 * 60 * 1000,
      SLOW: 120 * 60 * 1000,
      DAILY: 1440 * 60 * 1000,
    },
  };
}

export type Config = ReturnType<typeof loadConfig>;
