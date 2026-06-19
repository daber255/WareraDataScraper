import Database from 'better-sqlite3';
import path from 'node:path';

import {
  loadConfig,
  loadProdData,
  loadCountriesData,
  buildRankings,
  occupationSuffix,
  type RankEntry,
} from './report-utils.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(__dirname, '..');

const dataDir = path.resolve(process.env.SCRAPER_DATA_DIR || path.join(ROOT, 'data'));
const dbPath = path.join(dataDir, 'warera.db');

function fmtPct(v: number): string {
  return `${v.toFixed(1)}%`.padStart(7);
}

function fmtBtc(v: number): string {
  return `${v.toFixed(3)} BTC`.padStart(12);
}

function printBlock(
  label: string,
  entries: RankEntry[],
  showDep: boolean,
) {
  if (entries.length === 0) return;

  const cols = showDep
    ? `${'Rang'.padEnd(5)} ${'Controller'.padEnd(20)} ${'Region'.padEnd(22)} ${'Dep'.padStart(7)} ${'SR'.padStart(7)} ${'Total'.padStart(7)} ${'Profit/PP'.padStart(12)}`
    : `${'Rang'.padEnd(5)} ${'Controller'.padEnd(20)} ${'Region'.padEnd(22)} ${'SR'.padStart(7)} ${'Total'.padStart(7)} ${'Profit/PP'.padStart(12)}`;

  const sep = showDep
    ? `${''.padStart(5, '─')} ${''.padStart(20, '─')} ${''.padStart(22, '─')} ${''.padStart(7, '─')} ${''.padStart(7, '─')} ${''.padStart(7, '─')} ${''.padStart(12, '─')}`
    : `${''.padStart(5, '─')} ${''.padStart(20, '─')} ${''.padStart(22, '─')} ${''.padStart(7, '─')} ${''.padStart(7, '─')} ${''.padStart(12, '─')}`;

  console.log(`── ${label} ──`);
  console.log(` ${cols}`);
  console.log(` ${sep}`);

  for (let i = 0; i < Math.min(entries.length, 5); i++) {
    const r = entries[i];
    const occ = r.region ? occupationSuffix(r.region) : '';
    const rname = r.region ? (r.region.region_name + occ).slice(0, 22) : '—';
    const row = showDep
      ? `${String(i + 1).padEnd(5)} ${r.country.slice(0, 20).padEnd(20)} ${rname.padEnd(22)} ${fmtPct(r.depositBonus)} ${fmtPct(r.strategicBonus)} ${fmtPct(r.total)} ${fmtBtc(r.profitPerPP)}`
      : `${String(i + 1).padEnd(5)} ${r.country.slice(0, 20).padEnd(20)} ${rname.padEnd(22)} ${fmtPct(r.strategicBonus)} ${fmtPct(r.total)} ${fmtBtc(r.profitPerPP)}`;
    console.log(` ${row}`);
  }
  console.log();
}

function main() {
  const config = loadConfig();
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  const { items, prod, prices } = loadProdData(db);
  console.log(`\nProduktions-Bonus Report (${items.length} Items)\n`);

  const countriesMap = loadCountriesData(db);
  const topOverall: Array<{ item: string; country: string; region: import('./report-utils.js').RegionRow | null; total: number; profitPerPP: number }> = [];

  for (const item of items) {
    const def = prod[item];
    if (!def) continue;

    const all = buildRankings(item, countriesMap, config, prod, prices);
    const withDep = all.filter(r => r.total > 0);
    const withoutDep = all.filter(r => r.depositBonus === 0 && r.total > 0);

    const basePP = def.isDeposit
      ? `PP ${def.productionPoints}`
      : `PP ${def.productionPoints} | ${Object.entries(def.productionNeeds ?? {}).map(([k, v]) => `${k}×${v}`).join(', ')}`;
    console.log(`╔══ ${item} ══ ${basePP} ═${'═'.repeat(50)}`);

    if (withDep.length > 0) {
      printBlock(`${item} (Gesamt)`, withDep, true);
      topOverall.push({ item, country: withDep[0].country, region: withDep[0].region, total: withDep[0].total, profitPerPP: withDep[0].profitPerPP });
    }

    if (withoutDep.length > 0) {
      printBlock(`${item} (ohne Deposit)`, withoutDep, false);
    }
  }

  topOverall.sort((a, b) => b.profitPerPP - a.profitPerPP);
  console.log(`╔══ Top 5 Item/Country nach Profit/PP ═${'═'.repeat(55)}`);
  console.log(` ${'Rang'.padEnd(5)} ${'Item'.padEnd(14)} ${'Controller'.padEnd(20)} ${'Region'.padEnd(22)} ${'Total'.padStart(7)} ${'Profit/PP'.padStart(12)}`);
  console.log(` ${''.padStart(5, '─')} ${''.padStart(14, '─')} ${''.padStart(20, '─')} ${''.padStart(22, '─')} ${''.padStart(7, '─')} ${''.padStart(12, '─')}`);
  for (let i = 0; i < Math.min(topOverall.length, 5); i++) {
    const r = topOverall[i];
    const occ = r.region ? occupationSuffix(r.region) : '';
    const rname = r.region ? (r.region.region_name + occ).slice(0, 22) : '—';
    console.log(` ${String(i + 1).padEnd(5)} ${r.item.padEnd(14)} ${r.country.slice(0, 20).padEnd(20)} ${rname.padEnd(22)} ${fmtPct(r.total)} ${fmtBtc(r.profitPerPP)}`);
  }
  console.log();

  db.close();
}

main();
