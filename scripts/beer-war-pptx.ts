import 'dotenv/config';
import Database from 'better-sqlite3';
import PptxGenJSLib from 'pptxgenjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const dataDir = path.resolve(process.env.SCRAPER_DATA_DIR || path.join(ROOT, 'data'));
const dbPath = path.join(dataDir, 'warera.db');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

export { db };

const BEER_BLUE = '2563eb';
const BEER_ALT = 'eef2ff';
const BEER_DARK = '1e3a5f';
const ENEMY_RED = 'dc2626';
const ENEMY_ALT = 'fef2f2';
const DARK_GRAY = '1f2937';
const MID_GRAY = '6b7280';
const LIGHT_GRAY = 'f3f4f6';
const WHITE = 'ffffff';
const BORDER_LIGHT = 'e5e7eb';
const BORDER_MID = 'd1d5db';

// ── Helpers ──

export function fmtDmg(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(Math.round(n));
}

export function fmtBtc(n: number): string {
  return n.toFixed(4) + ' BTC';
}

export function fmtBtcShort(n: number): string {
  return n.toFixed(2) + ' BTC';
}

export function fmtBtcAbbr(n: number): string {
  const abs = Math.abs(n);
  let val: string;
  if (abs >= 1_000_000_000) val = (n / 1_000_000_000).toFixed(2) + 'B';
  else if (abs >= 1_000_000) val = (n / 1_000_000).toFixed(2) + 'M';
  else if (abs >= 1_000) val = (n / 1_000).toFixed(1) + 'k';
  else val = n.toFixed(2);
  return val + ' BTC';
}

// ── Battle ranking helpers (from snapshots) ──

function getMuRankingData(battleId: string, dataType: string, side: string): any[] {
  const endpoint = `battleRanking.getRanking:${battleId}:${dataType}:mu:${side}`;
  const row = db.prepare(
    'SELECT data FROM snapshots WHERE endpoint = ? ORDER BY fetched_at DESC LIMIT 1'
  ).get(endpoint) as { data: string } | undefined;
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.data);
    const items = parsed.rankings ?? parsed.items ?? parsed;
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

function getMuMoneyTotal(battleId: string, side: string): number {
  const items = getMuRankingData(battleId, 'money', side);
  return items.reduce((sum: number, item: any) => sum + (item.value ?? 0), 0);
}

function getMuDamageMap(battleId: string, side: string): Map<string, number> {
  const items = getMuRankingData(battleId, 'damage', side);
  return new Map(items.map((item: any) => [item.mu, item.value ?? 0]));
}

// ── Alliance loading ──

export interface AllianceInfo {
  name: string;
  countryIds: string[];
  countryNames: string[];
}

export function loadAlliances(): Map<string, AllianceInfo> {
  const map = new Map<string, AllianceInfo>();

  const rows = db.prepare(
    "SELECT name, member_countries FROM alliances WHERE is_disbanded = 0"
  ).all() as { name: string; member_countries: string }[];

  const allCountryIds = new Set<string>();
  const rawAlliances: { name: string; ids: string[] }[] = [];

  for (const row of rows) {
    let list: { country: string }[] = [];
    try { list = JSON.parse(row.member_countries) as { country: string }[]; } catch { list = []; }
    const ids = list.map(m => m.country).filter(Boolean);
    for (const id of ids) allCountryIds.add(id);
    rawAlliances.push({ name: row.name, ids });
  }

  // Resolve all country IDs to names in one query
  if (allCountryIds.size > 0) {
    const ph = [...allCountryIds].map(() => '?').join(',');
    const names = db.prepare(`SELECT id, name FROM countries WHERE id IN (${ph})`).all(...allCountryIds) as { id: string; name: string }[];
    const nameMap = new Map(names.map(n => [n.id, n.name]));

    for (const raw of rawAlliances) {
      const countryNames = raw.ids.map(id => nameMap.get(id) ?? id.slice(0, 12));
      map.set(raw.name, { name: raw.name, countryIds: raw.ids, countryNames });
    }
  }

  return map;
}

// ── Battle data ──

export interface BattleSummary {
  rank: number;
  id: string;
  attacker: string;
  defender: string;
  defenderRegion: string;
  totalDmg: number;
  roundsTotal: number;
  attackerWonRounds: number;
  defenderWonRounds: number;
  wonBy: string;
  isActive: boolean;
  beerSide: 'attacker' | 'defender';
  oppSide: 'attacker' | 'defender';
  beerDmg: number;
  oppDmg: number;
  beerMoneyPer1k: number;
  oppMoneyPer1k: number;
  beerCost: number; // contracts + bounties
  oppCost: number;
  beerContracts: number;
  oppContracts: number;
  beerBounties: number;
  oppBounties: number;
  rounds: { number: number; beerDmg: number; oppDmg: number }[];
  contracts: { muName: string; payout: number; perK: number; round: number }[];
  oppContractsList: { muName: string; payout: number; perK: number; round: number }[];
}

interface BattleRow {
  id: string; type: string; is_active: number; rounds_to_win: number;
  created_at: string; ended_at: string; won_by: string;
  attacker_country: string; defender_country: string;
  attacker_won_rounds: number; defender_won_rounds: number;
  attacker_money_pool: number; defender_money_pool: number;
  attacker_damages: number; defender_damages: number;
  attacker_money_per_1k_damages: number; defender_money_per_1k_damages: number;
}

interface RoundRow {
  number: number; attacker_damages: number; defender_damages: number;
}

interface ContractRow {
  for_country_side: string; current_payout: number; current_per_k: number;
  round_number: number; current_winner: string; minimum_damage: number;
}

function isBeerOnSide(beerIds: Set<string>, battle: BattleRow): { beerSide: 'attacker' | 'defender'; oppSide: 'attacker' | 'defender' } | null {
  if (beerIds.has(battle.attacker_country)) return { beerSide: 'attacker', oppSide: 'defender' };
  if (beerIds.has(battle.defender_country)) return { beerSide: 'defender', oppSide: 'attacker' };
  return null;
}

export function loadTopBattles(beerIds: Set<string>, countryNameMap: Map<string, string>, limit = 5): BattleSummary[] {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const ph = beerIds.size > 0 ? [...beerIds].map(() => '?').join(',') : '?';

  const rows = db.prepare(`
    SELECT b.*, COALESCE(r.name, b.defender_region) AS region_name
    FROM battles b
    LEFT JOIN regions r ON r.id = b.defender_region
    WHERE (b.created_at >= ? OR b.is_active = 1 OR (b.ended_at IS NOT NULL AND b.ended_at >= ?))
      AND (b.attacker_country IN (${ph}) OR b.defender_country IN (${ph}))
    ORDER BY (COALESCE(b.attacker_damages,0) + COALESCE(b.defender_damages,0)) DESC
    LIMIT ?
  `).all(cutoff, cutoff, ...beerIds, ...beerIds, limit) as (BattleRow & { region_name: string })[];

  const summaries: BattleSummary[] = [];

  for (const row of rows) {
    const sides = isBeerOnSide(beerIds, row);
    if (!sides) continue;

    const { beerSide, oppSide } = sides;
    const attName = countryNameMap.get(row.attacker_country) ?? row.attacker_country.slice(0, 12);
    const defName = countryNameMap.get(row.defender_country) ?? row.defender_country.slice(0, 12);

    // Rounds
    const roundRows = db.prepare(
      'SELECT number, attacker_damages, defender_damages FROM battle_rounds WHERE battle_id = ? ORDER BY number'
    ).all(row.id) as RoundRow[];

    const rounds = roundRows.map(r => ({
      number: r.number,
      beerDmg: beerSide === 'attacker' ? (r.attacker_damages ?? 0) : (r.defender_damages ?? 0),
      oppDmg: beerSide === 'attacker' ? (r.defender_damages ?? 0) : (r.attacker_damages ?? 0),
    }));

    const totalBeerDmg = rounds.reduce((s, r) => s + r.beerDmg, 0);
    const totalOppDmg = rounds.reduce((s, r) => s + r.oppDmg, 0);

    // Contracts
    const contractRows = db.prepare(
      'SELECT * FROM mercenary_contracts WHERE battle_id = ? ORDER BY round_number'
    ).all(row.id) as ContractRow[];

    const beerContracts = contractRows.filter(c => c.for_country_side === beerSide);
    const oppContracts = contractRows.filter(c => c.for_country_side === oppSide);

    // MU name resolution
    const allMuIds = [...new Set([...beerContracts, ...oppContracts].map(c => c.current_winner).filter(Boolean))];
    const muNames = new Map<string, string>();
    if (allMuIds.length > 0) {
      const mph = allMuIds.map(() => '?').join(',');
      const muRows = db.prepare(`SELECT id, name FROM military_units WHERE id IN (${mph})`).all(...allMuIds) as { id: string; name: string }[];
      for (const r of muRows) muNames.set(r.id, r.name);
    }

    const beerMuMoney = getMuMoneyTotal(row.id, beerSide);
    const oppMuMoney = getMuMoneyTotal(row.id, oppSide);
    const beerMuDamage = getMuDamageMap(row.id, beerSide);
    const oppMuDamage = getMuDamageMap(row.id, oppSide);

    const hasRankingData = beerMuDamage.size > 0 || oppMuDamage.size > 0;

    const completedBeerContracts = hasRankingData
      ? beerContracts.filter(c => (beerMuDamage.get(c.current_winner ?? '') ?? 0) >= c.minimum_damage)
      : beerContracts;
    const completedOppContracts = hasRankingData
      ? oppContracts.filter(c => (oppMuDamage.get(c.current_winner ?? '') ?? 0) >= c.minimum_damage)
      : oppContracts;

    const completedBeerContractSum = completedBeerContracts.reduce((s, c) => s + c.current_payout, 0);
    const completedOppContractSum = completedOppContracts.reduce((s, c) => s + c.current_payout, 0);

    const beerMoneyPool = beerSide === 'attacker' ? (row.attacker_money_pool ?? 0) : (row.defender_money_pool ?? 0);
    const oppMoneyPool = beerSide === 'attacker' ? (row.defender_money_pool ?? 0) : (row.attacker_money_pool ?? 0);
    const beerBounties = beerMuMoney > 0
      ? Math.max(0, beerMuMoney - completedBeerContractSum)
      : Math.max(0, beerMoneyPool - completedBeerContractSum);
    const oppBounties = oppMuMoney > 0
      ? Math.max(0, oppMuMoney - completedOppContractSum)
      : Math.max(0, oppMoneyPool - completedOppContractSum);

    summaries.push({
      rank: summaries.length + 1,
      id: row.id,
      attacker: attName,
      defender: defName,
      defenderRegion: (row as unknown as { region_name: string }).region_name ?? '?',
      totalDmg: totalBeerDmg + totalOppDmg,
      roundsTotal: roundRows.length,
      attackerWonRounds: row.attacker_won_rounds ?? 0,
      defenderWonRounds: row.defender_won_rounds ?? 0,
      wonBy: row.won_by ?? '?',
      isActive: row.is_active === 1,
      beerSide,
      oppSide,
      beerDmg: totalBeerDmg,
      oppDmg: totalOppDmg,
      beerMoneyPer1k: beerSide === 'attacker' ? (row.attacker_money_per_1k_damages ?? 0) : (row.defender_money_per_1k_damages ?? 0),
      oppMoneyPer1k: beerSide === 'attacker' ? (row.defender_money_per_1k_damages ?? 0) : (row.attacker_money_per_1k_damages ?? 0),
      beerCost: completedBeerContractSum + beerBounties,
      oppCost: completedOppContractSum + oppBounties,
      beerContracts: completedBeerContractSum,
      oppContracts: completedOppContractSum,
      beerBounties,
      oppBounties,
      rounds,
      contracts: completedBeerContracts.map(c => ({
        muName: muNames.get(c.current_winner ?? '') ?? (c.current_winner ?? '?').slice(0, 16),
        payout: c.current_payout,
        perK: c.current_per_k,
        round: c.round_number,
      })),
      oppContractsList: completedOppContracts.map(c => ({
        muName: muNames.get(c.current_winner ?? '') ?? (c.current_winner ?? '?').slice(0, 16),
        payout: c.current_payout,
        perK: c.current_per_k,
        round: c.round_number,
      })),
    });
  }

  return summaries;
}

// ── Single-pass user_history scanner ──

export interface WealthEntry {
  country: string;
  members: number;
  before: number;
  after: number;
  delta: number;
  warBefore: number;
  warAfter: number;
}

export interface DamageEntry {
  country: string;
  members: number;
  damage: number;
}

export function sumDamage(entries: DamageEntry[]): number {
  return entries.reduce((s, e) => s + e.damage, 0);
}

export function sumWealthDelta(entries: WealthEntry[]): { members: number; before: number; after: number; delta: number; warBefore: number; warAfter: number } {
  return entries.reduce(
    (s, e) => ({
      members: s.members + e.members,
      before: s.before + e.before,
      after: s.after + e.after,
      delta: s.delta + e.delta,
      warBefore: s.warBefore + e.warBefore,
      warAfter: s.warAfter + e.warAfter,
    }),
    { members: 0, before: 0, after: 0, delta: 0, warBefore: 0, warAfter: 0 },
  );
}

export interface BuildEntry {
  war: number;
  eco: number;
}

export interface AllianceData {
  wealth: WealthEntry[];
  damage: DamageEntry[];
  buildCounts: Map<string, BuildEntry>;
  buildCountsPrev: Map<string, BuildEntry>;
}

export interface AllianceHistory {
  beer: AllianceData;
  enemyAlliances: Map<string, AllianceData>;
}

export interface EquipmentCount {
  code: string;
  count: number;
  slot: string;
  level: number;
}

export function loadEquipmentUsage(beerIds: Set<string>): EquipmentCount[] {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  if (beerIds.size === 0) return [];
  const ph = [...beerIds].map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT eu.code, COUNT(*) as cnt
    FROM equipment_usage eu
    JOIN users u ON u.id = eu.buyer
    WHERE u.country IN (${ph})
      AND eu.updated_at >= ?
    GROUP BY eu.code
  `).all(...beerIds, cutoff) as { code: string; cnt: number }[];
  const weaponLevels: Record<string, number> = { knife: 0, gun: 1, rifle: 2, sniper: 3, tank: 4, jet: 5 };
  const result: EquipmentCount[] = [];
  for (const r of rows) {
    const m = r.code.match(/^(gloves|chest|boots|pants|helmet)(\d)$/);
    if (m) result.push({ code: r.code, count: r.cnt, slot: m[1], level: parseInt(m[2]) });
    else if (r.code in weaponLevels) result.push({ code: r.code, count: r.cnt, slot: 'weapon', level: weaponLevels[r.code] });
  }
  return result;
}

let _SCRIPT_T0 = Date.now();

export function loadAllHistory(alliances: Map<string, AllianceInfo>, countryNameMap: Map<string, string>, dateStr?: string): AllianceHistory {
  _SCRIPT_T0 = Date.now();
  const ts = () => ((Date.now() - _SCRIPT_T0) / 1000).toFixed(1) + 's';
  console.log(`  [t=${ts()}] Scanning user_history...`);

  // Get timestamps info
  const tsInfo = db.prepare(
    'SELECT DISTINCT fetched_at FROM user_history ORDER BY fetched_at'
  ).all() as { fetched_at: string }[];
  const timestamps = tsInfo.map(r => r.fetched_at);
  const latestTs = timestamps[timestamps.length - 1];
  const latestDate = latestTs.slice(0, 10);
  const targetDate = dateStr ?? latestDate;
  const latestDayTs = timestamps.filter(t => t.startsWith(targetDate));
  // Find latest timestamp from day before targetDate
  let prevDayTs = '';
  for (let i = timestamps.length - 2; i >= 0; i--) {
    if (!timestamps[i].startsWith(targetDate)) {
      prevDayTs = timestamps[i];
      break;
    }
  }

  // Get eligible users for each alliance
  function loadUserMap(countryIds: string[], lvlMin = 20): Map<string, string> {
    if (countryIds.length === 0) return new Map();
    const ph = countryIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT id, country FROM users WHERE level >= ? AND country IN (${ph})`
    ).all(lvlMin, ...countryIds) as { id: string; country: string }[];
    return new Map(rows.map(u => [u.id, u.country]));
  }

  // B.E.E.R
  const beerUserMap = loadUserMap(alliances.get('B.E.E.R')!.countryIds);

  // Load all non-B.E.E.R alliances from DB
  const dbAllianceRows = db.prepare(
    "SELECT name, member_countries FROM alliances WHERE name != 'B.E.E.R' AND is_disbanded = 0"
  ).all() as { name: string; member_countries: string }[];

  const enemyAllianceData: { name: string; countryIds: string[]; userMap: Map<string, string> }[] = [];
  for (const row of dbAllianceRows) {
    let list: { country: string }[] = [];
    try { list = JSON.parse(row.member_countries) as { country: string }[]; } catch { list = []; }
    const ids = list.map(m => m.country).filter(Boolean);
    if (ids.length === 0) continue;
    const userMap = loadUserMap(ids);
    if (userMap.size === 0) continue;
    enemyAllianceData.push({ name: row.name, countryIds: ids, userMap });
  }

  const allEligible = new Set([...beerUserMap.keys()]);
  for (const e of enemyAllianceData) {
    for (const id of e.userMap.keys()) allEligible.add(id);
  }

  const beerUserCount = beerUserMap.size;
  const enemyUserCount = enemyAllianceData.reduce((s, e) => s + e.userMap.size, 0);
  console.log(`  [t=${ts()}]   ${beerUserCount} B.E.E.R, ${enemyUserCount} enemy users (${enemyAllianceData.length} alliances)`);

  // Single full scan — include skill levels for war/eco classification
  const sql = `SELECT fetched_at, id,
    COALESCE(wealth_items,0)+COALESCE(wealth_money,0)+COALESCE(wealth_equipments,0)+COALESCE(wealth_weapons,0) as liquid,
    COALESCE(damages_delta,0) as damage,
    COALESCE(skill_attack_level,0) as sk_atk,
    COALESCE(skill_health_level,0) as sk_hlt,
    COALESCE(skill_armor_level,0) as sk_arm,
    COALESCE(skill_critical_chance_level,0) as sk_cch,
    COALESCE(skill_critical_damages_level,0) as sk_cdm,
    COALESCE(skill_precision_level,0) as sk_prc,
    COALESCE(skill_dodge_level,0) as sk_dod,
    COALESCE(skill_loot_chance_level,0) as sk_lot,
    COALESCE(skill_production_level,0) as sk_prd,
    COALESCE(skill_companies_level,0) as sk_cmp,
    COALESCE(skill_entrepreneurship_level,0) as sk_ent,
    COALESCE(skill_management_level,0) as sk_mgt
  FROM user_history`;
  type HistoryRow = { fetched_at: string; id: string; liquid: number; damage: number } & Record<string, number>;
  const rows = db.prepare(sql).all() as HistoryRow[];
  console.log(`  [t=${ts()}]   Read ${rows.length} rows`);

  interface TsUserData { liquid: number; damage: number; isWar: boolean | null }

  function classifySkills(r: HistoryRow): boolean | null {
    const warScore = r.sk_atk + r.sk_hlt + r.sk_arm + r.sk_cch + r.sk_cdm + r.sk_prc + r.sk_dod + r.sk_lot;
    const ecoScore = r.sk_prd + r.sk_cmp + r.sk_ent + r.sk_mgt;
    const total = warScore + ecoScore;
    if (total === 0) return null;
    return warScore / total > 0.5;
  }

  // Group by timestamp
  const byTs = new Map<string, Map<string, TsUserData>>();
  for (const row of rows) {
    if (!allEligible.has(row.id)) continue;
    let tsMap = byTs.get(row.fetched_at);
    if (!tsMap) { tsMap = new Map(); byTs.set(row.fetched_at, tsMap); }
    const existing = tsMap.get(row.id) ?? { liquid: 0, damage: 0, isWar: null as boolean | null };
    existing.liquid += row.liquid;
    existing.damage += row.damage;
    const wc = classifySkills(row);
    if (wc !== null) existing.isWar = wc;
    tsMap.set(row.id, existing);
  }

  function buildCountMapFromTs(tsData: Map<string, TsUserData> | undefined, userMap: Map<string, string>): Map<string, BuildEntry> {
    const m = new Map<string, BuildEntry>();
    if (!tsData) return m;
    for (const [id, data] of tsData) {
      if (data.isWar === null) continue;
      const country = userMap.get(id);
      if (!country) continue;
      const cName = countryNameMap.get(country) ?? country.slice(0, 12);
      let entry = m.get(cName);
      if (!entry) { entry = { war: 0, eco: 0 }; m.set(cName, entry); }
      if (data.isWar) entry.war++;
      else entry.eco++;
    }
    return m;
  }

  function compute(userMap: Map<string, string>): { wealth: WealthEntry[]; damage: DamageEntry[]; buildCounts: Map<string, BuildEntry>; buildCountsPrev: Map<string, BuildEntry> } {
    // Wealth: latest day vs previous day
    const latestWealth = byTs.get(latestTs);
    const prevWealth   = prevDayTs ? byTs.get(prevDayTs) : undefined;
    const wealthMap = new Map<string, { members: number; before: number; after: number; warBefore: number; warAfter: number }>();

    if (latestWealth && prevWealth) {
      for (const [id, data] of latestWealth) {
        const country = userMap.get(id);
        if (!country) continue;
        const prev = prevWealth.get(id)?.liquid ?? 0;
        const entry = wealthMap.get(country) ?? { members: 0, before: 0, after: 0, warBefore: 0, warAfter: 0 };
        entry.members++;
        entry.before += prev;
        entry.after += data.liquid;
        if (data.isWar) {
          entry.warBefore += prev;
          entry.warAfter += data.liquid;
        }
        wealthMap.set(country, entry);
      }
    }

    const wealth: WealthEntry[] = [...wealthMap.entries()]
      .map(([country, d]) => ({
        country: countryNameMap.get(country) ?? country,
        members: d.members,
        before: d.before,
        after: d.after,
        delta: d.after - d.before,
        warBefore: d.warBefore,
        warAfter: d.warAfter,
      }))
      .sort((a, b) => b.delta - a.delta);

    // Damage: sum damages_delta for latest day
    const dmgMap = new Map<string, { damage: number; members: Set<string> }>();
    for (const ts of latestDayTs) {
      const tsData = byTs.get(ts);
      if (!tsData) continue;
      for (const [id, data] of tsData) {
        const country = userMap.get(id);
        if (!country) continue;
        const entry = dmgMap.get(country) ?? { damage: 0, members: new Set<string>() };
        entry.damage += data.damage;
        entry.members.add(id);
        dmgMap.set(country, entry);
      }
    }

    const damage: DamageEntry[] = [...dmgMap.entries()]
      .map(([country, d]) => ({ country: countryNameMap.get(country) ?? country, members: d.members.size, damage: d.damage }))
      .sort((a, b) => b.damage - a.damage);

    const buildCounts = buildCountMapFromTs(latestWealth, userMap);
    const buildCountsPrev = buildCountMapFromTs(prevWealth, userMap);

    return { wealth, damage, buildCounts, buildCountsPrev };
  }

  // Compute B.E.E.R
  const beer: AllianceData = compute(beerUserMap);

  // Compute all enemy alliances
  const enemyAlliances = new Map<string, AllianceData>();
  for (const e of enemyAllianceData) {
    enemyAlliances.set(e.name, compute(e.userMap));
  }

  const result: AllianceHistory = { beer, enemyAlliances };
  console.log(`  [t=${ts()}] History computed`);
  return result;
}



// ── PPTX generation ──

function cell(text: string, opts: Record<string, unknown> = {}): { text: string; options: Record<string, unknown> } {
  return { text, options: opts };
}

function headerCell(text: string, color: string = BEER_BLUE): { text: string; options: Record<string, unknown> } {
  return cell(text, {
    fill: { color }, color: WHITE, bold: true, fontSize: 12, fontFace: 'Arial', align: 'center', valign: 'middle',
    border: { type: 'solid', color: BORDER_MID, pt: 0.5 },
    margin: [4, 6, 4, 6],
  });
}

function dataCell(text: string, opts: Record<string, unknown> = {}): { text: string; options: Record<string, unknown> } {
  return cell(text, {
    fontSize: 10, fontFace: 'Arial', align: 'center', valign: 'middle',
    border: { type: 'solid', color: BORDER_LIGHT, pt: 0.25 },
    margin: [3, 6, 3, 6],
    ...opts,
  });
}

function leftCell(text: string, opts: Record<string, unknown> = {}): { text: string; options: Record<string, unknown> } {
  return dataCell(text, { align: 'left', ...opts });
}

function totalCell(text: string, opts: Record<string, unknown> = {}): { text: string; options: Record<string, unknown> } {
  return dataCell(text, {
    bold: true, fill: { color: LIGHT_GRAY },
    border: [
      { type: 'solid', color: BORDER_MID, pt: 1 },
      { type: 'solid', color: BORDER_LIGHT, pt: 0.25 },
      { type: 'solid', color: BORDER_LIGHT, pt: 0.25 },
      { type: 'solid', color: BORDER_LIGHT, pt: 0.25 },
    ],
    ...opts,
  });
}

function buildTable(rows: { text: string; options: Record<string, unknown> }[][], colW: number[]): { text: string; options: Record<string, unknown> }[][] {
  return rows;
}

async function generatePptx(
  dateStr: string,
  alliances: Map<string, AllianceInfo>,
  battles: BattleSummary[],
  history: AllianceHistory,
  countryNameMap: Map<string, string>,
) {
  const { beer: { wealth: beerWealth, damage: beerDamage, buildCounts: beerBuildCounts, buildCountsPrev: beerBuildPrev }, enemyAlliances } = history;
  const PptxGenJS = (PptxGenJSLib as any).default ?? PptxGenJSLib;
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'WIDE', width: 13.33, height: 7.5 });
  pptx.layout = 'WIDE';


  function nameOf(id: string): string {
    return countryNameMap.get(id) ?? id.slice(0, 12);
  }

  // ── Slide 1: Title ──
  {
    const slide = pptx.addSlide();
    slide.background = { fill: WHITE };

    // Blue block top half
    slide.addShape(pptx.ShapeType.rect, {
      x: 0, y: 0, w: 13.33, h: 3.2,
      fill: { color: BEER_DARK },
    });
    slide.addText('B.E.E.R War Update', {
      x: 0, y: 0.8, w: 13.33, h: 1.2,
      fontSize: 40, fontFace: 'Arial', color: WHITE, bold: true, align: 'center',
    });
    slide.addText(dateStr, {
      x: 0, y: 2.0, w: 13.33, h: 0.7,
      fontSize: 18, fontFace: 'Arial', color: WHITE, align: 'center',
    });
    slide.addText('Daily War Report — Data Scraper', {
      x: 0, y: 3.6, w: 13.33, h: 0.6,
      fontSize: 14, fontFace: 'Arial', color: MID_GRAY, align: 'center',
    });

    const beerAlliance = alliances.get('B.E.E.R');
    if (beerAlliance) {
      slide.addText(`${beerAlliance.countryNames.length} members`, {
        x: 0.5, y: 4.5, w: 12.33, h: 0.5,
        fontSize: 12, fontFace: 'Arial', color: MID_GRAY, align: 'center',
      });
    }
  }

  // ── Slide 2: Top 5 Battles Overview ──
  {
    const slide = pptx.addSlide();
    slide.background = { fill: WHITE };

    slide.addShape(pptx.ShapeType.rect, {
      x: 0, y: 0, w: 13.33, h: 0.06,
      fill: { color: BEER_BLUE },
    });
    slide.addText(`Top ${battles.length} Battles (last 24h)`, {
      x: 0.5, y: 0.25, w: 12.33, h: 0.55,
      fontSize: 20, fontFace: 'Arial', color: BEER_BLUE, bold: true,
    });

    if (battles.length === 0) {
      slide.addText('No battles involving B.E.E.R in the last 24 hours.', {
        x: 0.5, y: 2, w: 12.33, h: 0.5,
        fontSize: 14, fontFace: 'Arial', color: MID_GRAY,
      });
    } else {
      const header = [
        headerCell('#'), headerCell('Attacker'), headerCell('Defender'),
        headerCell('Region'), headerCell('Total DMG'), headerCell('B.E.E.R DMG'), headerCell('Opp DMG'),
        headerCell('Rounds'), headerCell('Won By'),
        headerCell('B.E.E.R Cost'), headerCell('Opp Cost'),
      ];
      const rows = [header];

      for (let i = 0; i < battles.length; i++) {
        const b = battles[i];
        const altFill = i % 2 === 1 ? { color: BEER_ALT } : undefined;
        const status = b.isActive ? 'Active' : (b.wonBy === b.beerSide ? 'Won' : 'Lost');
        rows.push([
          dataCell(String(b.rank), { fill: altFill }),
          leftCell(b.attacker, { fill: b.beerSide === 'attacker' ? { color: 'dbeafe' } : altFill }),
          leftCell(b.defender, { fill: b.beerSide === 'defender' ? { color: 'dbeafe' } : altFill }),
          leftCell(b.defenderRegion, { fill: altFill, fontSize: 8 }),
          dataCell(fmtDmg(b.totalDmg), { bold: true, fill: altFill }),
          dataCell(fmtDmg(b.beerDmg), { fill: altFill }),
          dataCell(fmtDmg(b.oppDmg), { fill: altFill }),
          dataCell(`${b.attackerWonRounds}:${b.defenderWonRounds}`, { fill: altFill }),
          dataCell(status, { fill: altFill }),
          dataCell(fmtBtcShort(b.beerCost), { fill: altFill }),
          dataCell(fmtBtcShort(b.oppCost), { fill: altFill }),
        ]);
      }

      const colW = [0.4, 1.3, 1.3, 1.0, 1.1, 1.1, 1.1, 0.8, 1.0, 1.1, 1.1];
      slide.addTable(rows, { x: 0.5, y: 1.1, w: colW.reduce((a, b) => a + b, 0), colW, rowH: 0.35, autoPage: false });
    }
  }

  function fmtBuild(n: number, prev: number): string {
    const d = n - prev;
    if (d > 0) return `${n} (+${d})`;
    if (d < 0) return `${n} (${d})`;
    return `${n}`;
  }

  function fmtBuildPct(war: number, eco: number): string {
    const total = war + eco;
    if (total === 0) return '—';
    return `${Math.round(war / total * 100)}% / ${Math.round(eco / total * 100)}%`;
  }

  // ── Slide: B.E.E.R Stats ──
  {
    const slide = pptx.addSlide();
    slide.background = { fill: WHITE };

    slide.addShape(pptx.ShapeType.rect, {
      x: 0, y: 0, w: 13.33, h: 0.06,
      fill: { color: BEER_BLUE },
    });
    slide.addText('B.E.E.R Stats — Wealth, Damage & Builds', {
      x: 0.5, y: 0.15, w: 12.33, h: 0.45,
      fontSize: 18, fontFace: 'Arial', color: BEER_BLUE, bold: true,
    });
    slide.addText(`Level 20+  |  ${dateStr}`, {
      x: 0.5, y: 0.6, w: 12.33, h: 0.3,
      fontSize: 11, fontFace: 'Arial', color: MID_GRAY,
    });

    // Combined table: wealth + damage + builds
    const headerRow = [
      headerCell('Country'), headerCell('Members'), headerCell('Liquide Mittel'),
      headerCell('War Liq.'), headerCell('Liquid Avg'), headerCell('Liquid Δ'),
      headerCell('Damage'), headerCell('War (Δ)'), headerCell('Eco (Δ)'), headerCell('War/Eco %'),
    ];
    const rows = [headerRow];

    for (let i = 0; i < beerWealth.length; i++) {
      const w = beerWealth[i];
      const altFill = i % 2 === 1 ? { color: BEER_ALT } : undefined;
      const deltaStr = (w.delta >= 0 ? '+' : '') + fmtBtcAbbr(w.delta);
      const d = beerDamage.find(d => d.country === w.country);
      const bc = beerBuildCounts.get(w.country) ?? { war: 0, eco: 0 };
      const bp = beerBuildPrev.get(w.country) ?? { war: 0, eco: 0 };
      rows.push([
        leftCell(nameOf(w.country), { fill: altFill }),
        dataCell(String(w.members), { fill: altFill }),
        dataCell(fmtBtcAbbr(w.after), { fill: altFill }),
        dataCell(fmtBtcAbbr(w.warAfter), { fill: altFill }),
        dataCell(fmtBtcAbbr(w.after / w.members), { fill: altFill }),
        dataCell(deltaStr, { color: w.delta >= 0 ? BEER_BLUE : ENEMY_RED, bold: true, fill: altFill }),
        dataCell(d ? fmtDmg(d.damage) : '—', { fill: altFill }),
        dataCell(fmtBuild(bc.war, bp.war), { fill: altFill }),
        dataCell(fmtBuild(bc.eco, bp.eco), { fill: altFill }),
        dataCell(fmtBuildPct(bc.war, bc.eco), { fill: altFill }),
      ]);
    }

    // Totals
    if (beerWealth.length > 0) {
      const wt = sumWealthDelta(beerWealth);
      const wds = (wt.delta >= 0 ? '+' : '') + fmtBtcAbbr(wt.delta);
      const dt = sumDamage(beerDamage);
      const bcArr = [...beerBuildCounts.values()];
      const bpArr = [...beerBuildPrev.values()];
      const totalWar = bcArr.reduce((s, c) => s + c.war, 0);
      const totalEco = bcArr.reduce((s, c) => s + c.eco, 0);
      const prevWar = bpArr.reduce((s, c) => s + c.war, 0);
      const prevEco = bpArr.reduce((s, c) => s + c.eco, 0);
      rows.push([
        totalCell('TOTAL'), totalCell(String(wt.members)),
        totalCell(fmtBtcAbbr(wt.after)),
        totalCell(fmtBtcAbbr(wt.warAfter)),
        totalCell(fmtBtcAbbr(wt.after / wt.members)),
        totalCell(wds, { color: wt.delta >= 0 ? BEER_BLUE : ENEMY_RED, bold: true }),
        totalCell(fmtDmg(dt), { bold: true }),
        totalCell(fmtBuild(totalWar, prevWar)),
        totalCell(fmtBuild(totalEco, prevEco)),
        totalCell(fmtBuildPct(totalWar, totalEco)),
      ]);
    }

    const colW = [1.5, 0.6, 1.1, 0.9, 0.9, 1.0, 1.0, 0.8, 0.8, 1.0];
    slide.addTable(rows, { x: 0.5, y: 1.1, w: colW.reduce((a, b) => a + b, 0), colW, rowH: 0.3, autoPage: false, fontSize: 9 });
  }

  // ── Slide: Enemy Alliances Stats ──
  {
    const slide = pptx.addSlide();
    slide.background = { fill: WHITE };

    slide.addShape(pptx.ShapeType.rect, {
      x: 0, y: 0, w: 13.33, h: 0.06,
      fill: { color: ENEMY_RED },
    });
    slide.addText('Enemy Alliances Stats — Wealth, Damage & Builds', {
      x: 0.5, y: 0.15, w: 12.33, h: 0.45,
      fontSize: 18, fontFace: 'Arial', color: ENEMY_RED, bold: true,
    });
    slide.addText(`Level 20+  |  ${dateStr}`, {
      x: 0.5, y: 0.6, w: 12.33, h: 0.3,
      fontSize: 11, fontFace: 'Arial', color: MID_GRAY,
    });

    const headerRow = [
      headerCell('Alliance', ENEMY_RED), headerCell('Mmb', ENEMY_RED), headerCell('Liquide', ENEMY_RED),
      headerCell('War Liq.', ENEMY_RED), headerCell('Liquid Avg', ENEMY_RED), headerCell('Liquid Δ', ENEMY_RED),
      headerCell('Damage', ENEMY_RED), headerCell('War (Δ)', ENEMY_RED), headerCell('Eco (Δ)', ENEMY_RED),
      headerCell('W/E %', ENEMY_RED),
    ];

    // Build sorted list: by total damage descending
    const enemyList: { name: string; wealth: WealthEntry[]; damage: DamageEntry[]; buildCounts: Map<string, BuildEntry>; buildCountsPrev: Map<string, BuildEntry>; totalDmg: number }[] = [];
    for (const [name, data] of enemyAlliances) {
      const td = sumDamage(data.damage);
      enemyList.push({ name, wealth: data.wealth, damage: data.damage, buildCounts: data.buildCounts, buildCountsPrev: data.buildCountsPrev, totalDmg: td });
    }
    enemyList.sort((a, b) => b.totalDmg - a.totalDmg);

    const rows: { text: string; options: Record<string, unknown> }[][] = [headerRow];

    for (let i = 0; i < enemyList.length; i++) {
      const e = enemyList[i];
      const altFill = i % 2 === 1 ? { color: ENEMY_ALT } : undefined;
      const wt = sumWealthDelta(e.wealth);
      const deltaStr = (wt.delta >= 0 ? '+' : '') + fmtBtcAbbr(wt.delta);
      const bcArr = [...e.buildCounts.values()];
      const bpArr = [...e.buildCountsPrev.values()];
      const totalWar = bcArr.reduce((s, c) => s + c.war, 0);
      const totalEco = bcArr.reduce((s, c) => s + c.eco, 0);
      const prevWar = bpArr.reduce((s, c) => s + c.war, 0);
      const prevEco = bpArr.reduce((s, c) => s + c.eco, 0);
      rows.push([
        leftCell(e.name, { bold: true, fill: altFill }),
        dataCell(String(wt.members), { fill: altFill }),
        dataCell(fmtBtcAbbr(wt.after), { fill: altFill }),
        dataCell(fmtBtcAbbr(wt.warAfter), { fill: altFill }),
        dataCell(fmtBtcAbbr(wt.after / wt.members), { fill: altFill }),
        dataCell(deltaStr, { color: wt.delta >= 0 ? BEER_BLUE : ENEMY_RED, bold: true, fill: altFill }),
        dataCell(fmtDmg(e.totalDmg), { fill: altFill }),
        dataCell(fmtBuild(totalWar, prevWar), { fill: altFill }),
        dataCell(fmtBuild(totalEco, prevEco), { fill: altFill }),
        dataCell(fmtBuildPct(totalWar, totalEco), { fill: altFill }),
      ]);
    }

    const colW = [2.0, 0.55, 0.9, 0.8, 0.7, 0.9, 0.9, 0.7, 0.7, 0.7];
    slide.addTable(rows, { x: 0.5, y: 1.1, w: colW.reduce((a, b) => a + b, 0), colW, rowH: 0.3, autoPage: false, fontSize: 9 });
  }

  // Save
  const outDir = path.join(ROOT, 'reports');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `beer-war-update-${dateStr}.pptx`);
  await pptx.writeFile({ fileName: outFile });
  return outFile;
}

export function dominantDate(): string {
  const now = Date.now();
  const ws = new Date(now - 24 * 60 * 60 * 1000);
  const we = new Date(now);
  const wsDay = ws.toISOString().slice(0, 10);
  const weDay = we.toISOString().slice(0, 10);
  if (wsDay === weDay) return wsDay;
  const endDayStart = new Date(weDay + 'T00:00:00.000Z').getTime();
  const msPrev = endDayStart - ws.getTime();
  const msCur = we.getTime() - endDayStart;
  return msPrev >= msCur ? wsDay : weDay;
}

// ── Main ──

function main() {
  const dateStr = dominantDate();
  console.log(`╔═══════════════════════════════════════════════════════════════`);
  console.log(`║  B.E.E.R War Update – PPTX Report`);
  console.log(`║  ${dateStr}`);
  console.log(`╚═══════════════════════════════════════════════════════════════`);

  const ts = () => ((Date.now() - _t0) / 1000).toFixed(1) + 's';
  const _t0 = Date.now();

  // 1. Load alliances
  const alliances = loadAlliances();
  console.log(`  [t=${ts()}] alliances loaded`);
  const beerAlliance = alliances.get('B.E.E.R');
  if (!beerAlliance) {
    console.error('B.E.E.R alliance not found in database.');
    process.exit(1);
  }
  console.log(`  B.E.E.R: ${beerAlliance.countryNames.length} members`);
  console.log(`  Enemy alliances: ${alliances.size - 1} total`);
  console.log(`  [t=${ts()}] alliance info done`);

  const beerIds = new Set(beerAlliance.countryIds);

  // 2. Country name map (for battle)
  const allBattleCountryIds = new Set<string>();
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  if (beerIds.size > 0) {
    const ph = [...beerIds].map(() => '?').join(',');
    const battleRows = db.prepare(`
      SELECT attacker_country, defender_country FROM battles
      WHERE created_at >= ? AND (attacker_country IN (${ph}) OR defender_country IN (${ph}))
    `).all(cutoff, ...beerIds, ...beerIds) as { attacker_country: string; defender_country: string }[];
    for (const r of battleRows) {
      allBattleCountryIds.add(r.attacker_country);
      allBattleCountryIds.add(r.defender_country);
    }
  }
  // Also add alliance member IDs
  for (const a of alliances.values()) {
    for (const id of a.countryIds) allBattleCountryIds.add(id);
  }

  const countryNameMap = new Map<string, string>();
  if (allBattleCountryIds.size > 0) {
    const cph = [...allBattleCountryIds].map(() => '?').join(',');
    const cRows = db.prepare(`SELECT id, name FROM countries WHERE id IN (${cph})`).all(...allBattleCountryIds) as { id: string; name: string }[];
    for (const r of cRows) countryNameMap.set(r.id, r.name);
  }

  // 3. Load top 3 battles
  const battles = loadTopBattles(beerIds, countryNameMap, 5);
  console.log(`  Top battles (24h): ${battles.length}`);
  console.log(`  [t=${ts()}] battles done`);

  // 4. Load all history data (wealth + damage) in one full scan
  const history = loadAllHistory(alliances, countryNameMap, dateStr);
  console.log(`  [t=${ts()}] history loaded`);

  // 5. Generate PPTX
  generatePptx(dateStr, alliances, battles, history, countryNameMap)
    .then((outFile) => {
      console.log();
      console.log(`✅ Report saved to ${outFile}`);
      console.log();
    })
    .catch((err: unknown) => {
      console.error('Failed to generate PPTX:', err);
      process.exit(1);
    });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
