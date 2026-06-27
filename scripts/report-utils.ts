import 'dotenv/config';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(__dirname, '..');

export const CONFIG_PATH = path.join(ROOT, 'config/production-bonuses.json');

export type Json = Record<string, unknown>;

export interface Config {
  version: number;
  description: string;
  ethicSpecialisation: {
    industrial: { goods: string[]; bonusPerLevel: number; maxLevel: number };
    agricultural: { goods: string[]; bonusPerLevel: number; maxLevel: number };
  };
  deposit: { bonusPercent: number };
}

export interface RegionRow {
  region_name: string;
  country_id: string;
  controller: string;
  deposit: string | null;
  specialized_item: string | null;
  strategic_prod_bonus: number;
  ethics_industrialism: number;
  is_capital: number;
  initial_country: string;
}

export interface CountryAccum {
  id: string;
  name: string;
  specialized_item: string | null;
  strategic_prod_bonus: number;
  ethics_industrialism: number;
  tax_income: number;
  regions: RegionRow[];
}

export interface ItemProd {
  productionPoints: number;
  productionNeeds: Record<string, number> | null;
  isDeposit: boolean;
}

export interface RankEntry {
  country: string;
  region: RegionRow | null;
  depositBonus: number;
  strategicBonus: number;
  ethicBonus: number;
  total: number;
  profitPerPP: number;
}

export interface WageEntry {
  item: string;
  country: string;
  region: RegionRow | null;
  depositDisplay: string;
  totalBonus: number;
  baseProfitPerPP: number;
  grossWage: number;
  taxIncome: number;
  netWage: number;
}

export function loadConfig(): Config {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

export function loadProdData(db: Database.Database): { items: string[]; prod: Record<string, ItemProd>; prices: Record<string, number> } {
  const gcRow = db
    .prepare("SELECT data FROM snapshots WHERE endpoint = 'gameConfig.getGameConfig' ORDER BY fetched_at DESC LIMIT 1")
    .get() as { data: string } | undefined;

  const priceRow = db
    .prepare('SELECT * FROM item_prices ORDER BY fetched_at DESC LIMIT 1')
    .get() as Record<string, number> | undefined;

  const prices: Record<string, number> = {};
  if (priceRow) {
    for (const [k, v] of Object.entries(priceRow)) {
      if (k !== 'fetched_at') prices[k] = v ?? 0;
    }
  }

  const items: string[] = [];
  const prod: Record<string, ItemProd> = {};

  if (gcRow) {
    const gc: Json = JSON.parse(gcRow.data);
    const gameItems = (gc.items ?? {}) as Record<string, Json>;
    for (const [code, def] of Object.entries(gameItems)) {
      const needs = (def.productionNeeds as Record<string, number> | undefined) ?? null;
      const pp = (def.productionPoints as number) ?? 1;
      const isDep = def.isDeposit === true;
      if (needs || isDep) {
        items.push(code);
        prod[code] = { productionPoints: pp, productionNeeds: needs, isDeposit: isDep };
      }
    }
    items.sort();
  }

  return { items, prod, prices };
}

export function computeEthicBonus(item: string, industrialism: number, specializedItem: string | null, config: Config): number {
  const { industrial, agricultural } = config.ethicSpecialisation;

  if (specializedItem === null) {
    if (industrialism > 0 && industrial.goods.includes(item)) {
      return Math.min(industrialism, industrial.maxLevel) * industrial.bonusPerLevel;
    }
    if (industrialism < 0 && agricultural.goods.includes(item)) {
      return Math.min(Math.abs(industrialism), agricultural.maxLevel) * agricultural.bonusPerLevel;
    }
    return 0;
  }

  if (item !== specializedItem) return 0;

  if (industrialism > 0 && industrial.goods.includes(item)) {
    return Math.min(industrialism, industrial.maxLevel) * industrial.bonusPerLevel;
  }
  if (industrialism < 0 && agricultural.goods.includes(item)) {
    return Math.min(Math.abs(industrialism), agricultural.maxLevel) * agricultural.bonusPerLevel;
  }
  return 0;
}

export function getDepositType(depositJson: string | null): string | null {
  if (!depositJson) return null;
  try {
    const d: Json = JSON.parse(depositJson);
    return (d.type as string) ?? null;
  } catch {
    return null;
  }
}

export function pickBestRegion(regions: RegionRow[], item: string): RegionRow | null {
  const own = (r: RegionRow) => r.country_id === r.initial_country;

  let match = regions.filter(r => own(r) && getDepositType(r.deposit) === item);
  if (match.length > 0) return match[0];
  match = regions.filter(r => getDepositType(r.deposit) === item);
  if (match.length > 0) return match[0];

  match = regions.filter(r => own(r) && r.is_capital === 1);
  if (match.length > 0) return match[0];
  match = regions.filter(r => r.is_capital === 1);
  if (match.length > 0) return match[0];

  const sorted = regions.filter(r => own(r)).sort((a, b) => a.region_name.localeCompare(b.region_name));
  if (sorted.length > 0) return sorted[0];

  return regions.length > 0
    ? [...regions].sort((a, b) => a.region_name.localeCompare(b.region_name))[0]
    : null;
}

export function getDepositDuration(region: RegionRow | null, item: string): string {
  if (!region) return '—';
  const depType = getDepositType(region.deposit);
  if (depType !== item) return '—';
  try {
    const d: Json = JSON.parse(region.deposit!);
    const endsAt = d.endsAt as string | undefined;
    if (!endsAt) return '✓';
    const ms = new Date(endsAt).getTime() - Date.now();
    if (ms <= 0) return '✓ 0min';
    const hours = Math.floor(ms / 3600000);
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    if (days > 0) return `✓ ${days}d ${remHours}h`;
    const minutes = Math.ceil(ms / 60000);
    if (hours > 0) return `✓ ${hours}h`;
    return `✓ ${minutes}min`;
  } catch {
    return '✓';
  }
}

export function occupationSuffix(region: RegionRow): string {
  return region.country_id !== region.initial_country ? ' (besetzt)' : '';
}

export function computeBaseProfitPerPP(
  item: string,
  prod: Record<string, ItemProd>,
  prices: Record<string, number>,
): number {
  const def = prod[item];
  if (!def) return 0;
  const sellPrice = prices[item] ?? 0;
  let inputCost = 0;
  if (!def.isDeposit && def.productionNeeds) {
    for (const [inputCode, qty] of Object.entries(def.productionNeeds)) {
      inputCost += (prices[inputCode] ?? 0) * qty;
    }
  }
  return (sellPrice - inputCost) / def.productionPoints;
}

export function computeProfitPerPP(
  item: string,
  totalBonus: number,
  prod: Record<string, ItemProd>,
  prices: Record<string, number>,
): number {
  const def = prod[item];
  if (!def) return 0;

  const outputMultiplier = 1 + totalBonus / 100;
  const pp = def.productionPoints;
  const sellPrice = prices[item] ?? 0;

  let inputCost = 0;
  if (!def.isDeposit && def.productionNeeds) {
    for (const [inputCode, qty] of Object.entries(def.productionNeeds)) {
      inputCost += (prices[inputCode] ?? 0) * qty;
    }
  }

  const baseProfitPerPP = (sellPrice - inputCost) / pp;
  return baseProfitPerPP * outputMultiplier;
}

export function buildRankings(
  item: string,
  countries: Map<string, CountryAccum>,
  config: Config,
  prod: Record<string, ItemProd>,
  prices: Record<string, number>,
): RankEntry[] {
  const depositPct = config.deposit.bonusPercent;
  const ranking: RankEntry[] = [];

  for (const [, c] of countries) {
    const depositMatch = c.regions.some(r => getDepositType(r.deposit) === item);
    const strategicBonus = c.specialized_item === item ? c.strategic_prod_bonus : 0;
    const ethicBonus = computeEthicBonus(item, c.ethics_industrialism, c.specialized_item, config);
    const total = (depositMatch ? depositPct : 0) + strategicBonus + ethicBonus;

    ranking.push({
      country: c.name,
      region: pickBestRegion(c.regions, item),
      depositBonus: depositMatch ? depositPct : 0,
      strategicBonus,
      ethicBonus,
      total,
      profitPerPP: computeProfitPerPP(item, total, prod, prices),
    });
  }

  ranking.sort((a, b) => b.profitPerPP - a.profitPerPP);
  return ranking;
}

export function computeWageEntries(
  items: string[],
  countriesMap: Map<string, CountryAccum>,
  config: Config,
  prod: Record<string, ItemProd>,
  prices: Record<string, number>,
  fidelity: number,
): WageEntry[] {
  const entries: WageEntry[] = [];

  for (const item of items) {
    const base = computeBaseProfitPerPP(item, prod, prices);
    if (base <= 0) continue;

    for (const [, c] of countriesMap) {
      const bestRegion = pickBestRegion(c.regions, item);
      const depositMatch = c.regions.some(r => getDepositType(r.deposit) === item);
      const strategicBonus = c.specialized_item === item ? c.strategic_prod_bonus : 0;
      const ethicBonus = computeEthicBonus(item, c.ethics_industrialism, c.specialized_item, config);
      const totalBonus = (depositMatch ? config.deposit.bonusPercent : 0) + strategicBonus + ethicBonus + fidelity;
      const grossWage = Math.round(base * (1 + totalBonus / 100) * 1000) / 1000;
      const netWage = Math.round(grossWage * (1 - c.tax_income / 100) * 1000) / 1000;

      entries.push({
        item,
        country: c.name,
        region: bestRegion,
        depositDisplay: getDepositDuration(bestRegion, item),
        totalBonus,
        baseProfitPerPP: Math.round(base * 1000) / 1000,
        grossWage,
        taxIncome: c.tax_income,
        netWage,
      });
    }
  }

  entries.sort((a, b) => b.netWage - a.netWage);
  return entries;
}

export function loadCountriesData(db: Database.Database): Map<string, CountryAccum> {
  const regions = db
    .prepare(
      `SELECT
        r.name AS region_name,
        r.country_id,
        r.deposit,
        r.is_capital,
        r.initial_country,
        c.name AS controller,
        c.specialized_item,
        c.strategic_prod_bonus,
        c.tax_income,
        COALESCE(p.ethics_industrialism, 0) AS ethics_industrialism
      FROM regions r
      JOIN countries c ON c.id = r.country_id
      LEFT JOIN parties p ON p.id = c.ruling_party`,
    )
    .all() as (RegionRow & { tax_income: number })[];

  const countriesMap = new Map<string, CountryAccum>();
  for (const r of regions) {
    let acc = countriesMap.get(r.controller);
    if (!acc) {
      acc = {
        id: r.country_id,
        name: r.controller,
        specialized_item: r.specialized_item,
        strategic_prod_bonus: r.strategic_prod_bonus,
        ethics_industrialism: r.ethics_industrialism,
        tax_income: r.tax_income,
        regions: [],
      };
      countriesMap.set(r.controller, acc);
    }
    acc.regions.push(r);
  }

  return countriesMap;
}
