import Database from 'better-sqlite3';
import path from 'node:path';

import {
  loadConfig,
  loadProdData,
  loadCountriesData,
  computeWageEntries,
  occupationSuffix,
  type WageEntry,
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

function fmtItem(s: string): string {
  return s.slice(0, 14).padEnd(14);
}

function fmtCountry(s: string): string {
  return s.slice(0, 20).padEnd(20);
}

function fmtRegion(s: string): string {
  return s.slice(0, 22).padEnd(22);
}

function fmtTax(v: number): string {
  return `${v.toFixed(1)}%`.padStart(7);
}

function fmtDep(v: string): string {
  return v.padStart(7);
}

function printWageBlock(fidelity: number, entries: WageEntry[]) {
  const top = entries.slice(0, 20);
  if (top.length === 0) return;

  console.log(`══ Top ${top.length} nach NetWage/PP (Fidelity = ${fidelity}%) ══`);
  const cols = `${'Rang'.padEnd(5)} ${'Item'.padEnd(14)} ${'Controller'.padEnd(20)} ${'Region'.padEnd(22)} ${'Dep'.padStart(7)} ${'Brutto/PP'.padStart(12)} ${'tax'.padStart(7)} ${'Netto/PP'.padStart(12)}`;
  const sep = `${''.padStart(5, '─')} ${''.padStart(14, '─')} ${''.padStart(20, '─')} ${''.padStart(22, '─')} ${''.padStart(7, '─')} ${''.padStart(12, '─')} ${''.padStart(7, '─')} ${''.padStart(12, '─')}`;
  console.log(` ${cols}`);
  console.log(` ${sep}`);

  for (let i = 0; i < top.length; i++) {
    const r = top[i];
    const occ = r.region ? occupationSuffix(r.region) : '';
    const rname = r.region ? (r.region.region_name + occ).slice(0, 22) : '—';
    console.log(
      ` ${String(i + 1).padEnd(5)}` +
      ` ${fmtItem(r.item)}` +
      ` ${fmtCountry(r.country)}` +
      ` ${fmtRegion(rname)}` +
      ` ${fmtDep(r.depositDisplay)}` +
      ` ${fmtBtc(r.grossWage)}` +
      ` ${fmtTax(r.taxIncome)}` +
      ` ${fmtBtc(r.netWage)}`,
    );
  }
  console.log();
}

function main() {
  const config = loadConfig();
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  const { items, prod, prices } = loadProdData(db);
  console.log(`\nBreak-Even Net Wage Report (${items.length} Items)\n`);

  const countriesMap = loadCountriesData(db);

  for (const fidelity of [0, 10]) {
    const entries = computeWageEntries(items, countriesMap, config, prod, prices, fidelity);
    printWageBlock(fidelity, entries);
  }

  db.close();
}

main();
