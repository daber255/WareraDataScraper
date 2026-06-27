import 'dotenv/config';
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

import {
  loadConfig,
  loadProdData,
  loadCountriesData,
  buildRankings,
  computeBaseProfitPerPP,
  computeEthicBonus,
  getDepositType,
  getDepositDuration,
  pickBestRegion,
  occupationSuffix,
  type RegionRow,
} from './report-utils.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(__dirname, '..');

const dataDir = path.resolve(process.env.SCRAPER_DATA_DIR || path.join(ROOT, 'data'));
const dbPath = path.join(dataDir, 'warera.db');
const outDir = path.join(ROOT, 'docs');
const outFile = path.join(outDir, 'index.html');

interface ItemMeta {
  name: string;
  color: string;
  group: string;
}

interface SectionTab {
  id: string;
  label: string;
}

interface SectionDef {
  id: string;
  label: string;
  tabs: SectionTab[];
}

const SECTIONS: SectionDef[] = [
  {
    id: 'economy',
    label: 'Wirtschaft',
    tabs: [
      { id: 'prices',     label: 'Preise' },
      { id: 'production', label: 'Produktion' },
      { id: 'wages',      label: 'Löhne' },
    ],
  },
  {
    id: 'players',
    label: 'Spieler',
    tabs: [
      { id: 'overview',   label: 'Übersicht' },
    ],
  },
  {
    id: 'wealth',
    label: 'Vermögen',
    tabs: [
      { id: 'search', label: 'Suche' },
    ],
  },
  {
    id: 'country-compare',
    label: 'Ländervergleich',
    tabs: [
      { id: 'wealth', label: 'Vermögen' },
    ],
  },
];

const ITEM_META: Record<string, ItemMeta> = {
  // Metals / Construction (blues & grays)
  iron:       { name: 'Iron',       color: '#4a90d9', group: 'metal' },
  steel:      { name: 'Steel',      color: '#5a9fe6', group: 'metal' },
  lead:       { name: 'Lead',       color: '#6b7b8d', group: 'metal' },
  limestone:  { name: 'Limestone',  color: '#8a9ba8', group: 'metal' },
  concrete:   { name: 'Concrete',   color: '#9ba8b5', group: 'metal' },
  scraps:     { name: 'Scraps',     color: '#7a8a99', group: 'metal' },
  // Petrochemicals (ambers)
  petroleum:  { name: 'Petroleum',  color: '#d97706', group: 'petro' },
  oil:        { name: 'Oil',        color: '#b45309', group: 'petro' },
  // Agriculture / Food (greens & earth)
  grain:      { name: 'Grain',      color: '#65a30d', group: 'agri' },
  bread:      { name: 'Bread',      color: '#a3e635', group: 'agri' },
  livestock:  { name: 'Livestock',  color: '#4d7c0f', group: 'agri' },
  steak:      { name: 'Steak',      color: '#92400e', group: 'agri' },
  fish:       { name: 'Fish',       color: '#0ea5e9', group: 'agri' },
  cookedFish: { name: 'Cooked Fish',color: '#0284c7', group: 'agri' },
  coca:       { name: 'Coca',       color: '#22c55e', group: 'agri' },
  cocain:     { name: 'Cocain',     color: '#16a34a', group: 'agri' },
  // Ammunition (reds)
  ammo:       { name: 'Ammo',       color: '#ef4444', group: 'ammo' },
  lightAmmo:  { name: 'Light Ammo', color: '#f97316', group: 'ammo' },
  heavyAmmo:  { name: 'Heavy Ammo', color: '#dc2626', group: 'ammo' },
  // Wood / Paper (browns)
  wood:       { name: 'Wood',       color: '#92400e', group: 'wood' },
  paper:      { name: 'Paper',      color: '#ca8a04', group: 'wood' },
  // Special
  case1:      { name: 'Case I',     color: '#a855f7', group: 'special' },
  case2:      { name: 'Case II',    color: '#7c3aed', group: 'special' },
};

function loadPriceHistory(db: Database.Database) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
  const rows = db.prepare('SELECT * FROM item_prices WHERE fetched_at >= ? ORDER BY fetched_at ASC').all(thirtyDaysAgo) as Record<string, unknown>[];
  return rows;
}

function loadPlayerData(db: Database.Database) {
  const timeline = db.prepare(
    'SELECT fetched_at, COUNT(*) as total FROM user_history GROUP BY fetched_at ORDER BY fetched_at'
  ).all() as { fetched_at: string; total: number }[];

  const timestamps = db.prepare(
    'SELECT DISTINCT fetched_at FROM user_history ORDER BY fetched_at DESC LIMIT 2'
  ).all() as { fetched_at: string }[];

  const gainers: Array<{ country: string; before: number; after: number; delta: number }> = [];
  const losers: typeof gainers = [];

  if (timestamps.length >= 2) {
    const latestTs = timestamps[0].fetched_at;
    const prevTs = timestamps[1].fetched_at;

    const latestRows = db.prepare(`
      SELECT c.name, COUNT(*) as cnt
      FROM user_history uh
      JOIN countries c ON c.id = uh.country
      WHERE uh.fetched_at = ?
      GROUP BY c.name
    `).all(latestTs) as { name: string; cnt: number }[];

    const prevRows = db.prepare(`
      SELECT c.name, COUNT(*) as cnt
      FROM user_history uh
      JOIN countries c ON c.id = uh.country
      WHERE uh.fetched_at = ?
      GROUP BY c.name
    `).all(prevTs) as { name: string; cnt: number }[];

    const latestMap = new Map(latestRows.map(r => [r.name, r.cnt]));
    const prevMap = new Map(prevRows.map(r => [r.name, r.cnt]));
    const allCountries = new Set([...latestMap.keys(), ...prevMap.keys()]);

    const changes: Array<{ country: string; before: number; after: number; delta: number }> = [];
    for (const country of allCountries) {
      const after = latestMap.get(country) ?? 0;
      const before = prevMap.get(country) ?? 0;
      const delta = after - before;
      if (delta !== 0) {
        changes.push({ country, before, after, delta });
      }
    }

    changes.sort((a, b) => b.delta - a.delta);
    for (const c of changes) {
      if (c.delta > 0 && gainers.length < 5) gainers.push(c);
      if (c.delta < 0 && losers.length < 5) losers.push(c);
    }
    losers.sort((a, b) => a.delta - b.delta);
  }

  return { timeline, gainers, losers };
}

function parseMemberIds(raw: unknown): string[] {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed)) {
      return parsed.map((m: unknown) => typeof m === 'string' ? m : ((m as any)._id ?? (m as any).id ?? '')).filter(Boolean);
    }
  } catch { /* skip */ }
  return [];
}

type HistEntry = { t: string; total: number; avg: number; members: number } & Record<string, number>;
function dailyAggregate(entries: HistEntry[]) {
  const keys = new Set<string>();
  for (const e of entries) for (const k of Object.keys(e)) if (!['t', 'total', 'avg', 'members'].includes(k)) keys.add(k);
  const sumKeys = [...keys];

  const byDay = new Map<string, Record<string, number>>();
  for (const e of entries) {
    const day = e.t.slice(0, 10);
    let d = byDay.get(day);
    if (!d) {
      d = { total: 0, avgSum: 0, members: 0, count: 0 };
      for (const k of sumKeys) d[k] = 0;
      byDay.set(day, d);
    }
    d.total += e.total;
    d.avgSum += e.avg;
    d.members += e.members;
    d.count++;
    for (const k of sumKeys) d[k] += (e as any)[k] ?? 0;
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, d]) => {
      const r: Record<string, unknown> = {
        t: day,
        total: Math.round((d.total / d.count) * 100) / 100,
        avg: Math.round((d.avgSum / d.count) * 100) / 100,
        members: Math.round(d.members / d.count),
      };
      for (const k of sumKeys) r[k] = Math.round((d[k] / d.count) * 100) / 100;
      return r as HistEntry;
    });
}

function removeDips(arr: HistEntry[]): HistEntry[] {
  if (arr.length < 3) return arr;
  const fields = Object.keys(arr[0]).filter(k => k !== 't');
  const out = arr.map(e => ({ ...e }));
  for (let i = 1; i < out.length - 1; i++) {
    const prev = out[i - 1];
    const cur = out[i];
    const next = out[i + 1];
    if (cur.total <= 0 || prev.total <= 0 || next.total <= 0) continue;
    if (cur.total / prev.total < 0.6 && next.total / cur.total > 1.5) {
      const ratio = (i - (i - 1)) / ((i + 1) - (i - 1));
      for (const f of fields) {
        (cur as any)[f] = Math.round(((prev as any)[f] + ((next as any)[f] - (prev as any)[f]) * ratio) * 100) / 100;
      }
      cur.members = Math.round((prev.members + (next.members - prev.members) * ratio));
    }
  }
  return out;
}

function loadWealthData(db: Database.Database) {
  const t0 = Date.now();
  console.log('  Loading wealth data...');

  const search: Record<string, unknown>[] = [];
  const historyGroups: Record<string, unknown> = {};
  const historyUsers: Record<string, unknown> = {};

  // ── Users (search) ──
  const users = db.prepare(
    `SELECT id, username, country, wealth,
            wealth_equipments, wealth_weapons, wealth_items, wealth_money, wealth_companies
     FROM users WHERE wealth > 0`
  ).all() as Record<string, unknown>[];

  const userWealthMap = new Map<string, Record<string, unknown>>();
  for (const u of users) {
    userWealthMap.set(u.id as string, u);
    const eq0 = u.wealth_equipments as number ?? 0;
    const wp0 = u.wealth_weapons as number ?? 0;
    const it0 = u.wealth_items as number ?? 0;
    const mo0 = u.wealth_money as number ?? 0;
    const co0 = u.wealth_companies as number ?? 0;
    search.push({
      type: 'user', id: u.id, name: u.username ?? u.id, sub: u.country ?? null,
      memberCount: 1, totalWealth: u.wealth, avgWealth: u.wealth,
      equipments: eq0, weapons: wp0, items: it0, money: mo0, companies: co0,
      avgEquipments: eq0, avgWeapons: wp0, avgItems: it0, avgMoney: mo0, avgCompanies: co0,
    });
  }

  // ── User history (aggregated daily, only top users by wealth) ──
  const userHist = db.prepare(
    `SELECT id, fetched_at, wealth,
            wealth_equipments, wealth_weapons, wealth_items, wealth_money, wealth_companies
     FROM user_history
     WHERE fetched_at >= datetime('now', '-30 days')
     ORDER BY fetched_at`
  ).all() as Record<string, unknown>[];

  const rawUserHist = new Map<string, unknown[]>();
  for (const row of userHist) {
    const key = 'user_' + row.id;
    (rawUserHist.get(key) ?? rawUserHist.set(key, []).get(key)!).push({
      t: (row.fetched_at as string).slice(0, 16),
      total: row.wealth,
      avg: row.wealth,
      members: 1,
      equipments: row.wealth_equipments ?? 0,
      weapons: row.wealth_weapons ?? 0,
      items: row.wealth_items ?? 0,
      money: row.wealth_money ?? 0,
      companies: row.wealth_companies ?? 0,
    });
  }

  // Only keep history for top 2000 users by current wealth
  const topUsers = [...userWealthMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2000)
    .map(e => 'user_' + e[0]);
  const topUserSet = new Set(topUsers);

  for (const [key, entries] of rawUserHist) {
    if (topUserSet.has(key)) {
      historyUsers[key] = removeDips(dailyAggregate(entries as any[]));
    }
  }

  // ── Countries (search) ──
  const countries = db.prepare(
    `SELECT u.country, c.name,
            COUNT(*) as cnt, SUM(u.wealth) as total, AVG(u.wealth) as avg,
            SUM(u.wealth_equipments) as eq, SUM(u.wealth_weapons) as wp,
            SUM(u.wealth_items) as it, SUM(u.wealth_money) as mo,
            SUM(u.wealth_companies) as co
     FROM users u
     JOIN countries c ON c.id = u.country
     WHERE u.wealth > 0
     GROUP BY u.country`
  ).all() as Record<string, unknown>[];

  for (const c of countries) {
    const cnt = c.cnt as number;
    const eqTotal = c.eq as number ?? 0;
    const wpTotal = c.wp as number ?? 0;
    const itTotal = c.it as number ?? 0;
    const moTotal = c.mo as number ?? 0;
    const coTotal = c.co as number ?? 0;
    search.push({
      type: 'country', id: c.country, name: c.name,
      memberCount: cnt, totalWealth: c.total, avgWealth: Math.round((c.avg as number) * 100) / 100,
      equipments: eqTotal, weapons: wpTotal, items: itTotal,
      money: moTotal, companies: coTotal,
      avgEquipments: Math.round((eqTotal / cnt) * 100) / 100,
      avgWeapons: Math.round((wpTotal / cnt) * 100) / 100,
      avgItems: Math.round((itTotal / cnt) * 100) / 100,
      avgMoney: Math.round((moTotal / cnt) * 100) / 100,
      avgCompanies: Math.round((coTotal / cnt) * 100) / 100,
    });
  }

  // ── Country history (aggregated daily) ──
  const countryHist = db.prepare(
    `SELECT uh.country, uh.fetched_at,
            COUNT(*) as cnt, SUM(uh.wealth) as total, AVG(uh.wealth) as avg,
            SUM(uh.wealth_equipments) as eq, SUM(uh.wealth_weapons) as wp,
            SUM(uh.wealth_items) as it, SUM(uh.wealth_money) as mo,
            SUM(uh.wealth_companies) as co
     FROM user_history uh
     WHERE uh.fetched_at >= datetime('now', '-30 days')
     GROUP BY uh.country, uh.fetched_at
     ORDER BY uh.country, uh.fetched_at`
  ).all() as Record<string, unknown>[];

  const rawCountryHist = new Map<string, unknown[]>();
  for (const row of countryHist) {
    const key = 'country_' + row.country;
    (rawCountryHist.get(key) ?? rawCountryHist.set(key, []).get(key)!).push({
      t: (row.fetched_at as string).slice(0, 16),
      total: row.total,
      avg: Math.round((row.avg as number) * 100) / 100,
      members: row.cnt,
      equipments: row.eq ?? 0,
      weapons: row.wp ?? 0,
      items: row.it ?? 0,
      money: row.mo ?? 0,
      companies: row.co ?? 0,
    });
  }
  for (const [key, entries] of rawCountryHist) {
    historyGroups[key] = removeDips(dailyAggregate(entries as any[]));
  }

  // ── MUs (search) ──
  const mus = db.prepare(`SELECT id, name, members FROM military_units WHERE members IS NOT NULL`).all() as Record<string, unknown>[];
  const muMembership = new Map<string, string[]>();

  for (const mu of mus) {
    const ids = parseMemberIds(mu.members);
    if (ids.length === 0) continue;
    muMembership.set(mu.id as string, ids);

    let total = 0, eq = 0, wp = 0, it = 0, mo = 0, co = 0, cnt = 0;
    for (const uid of ids) {
      const u = userWealthMap.get(uid);
      if (u) {
        total += (u.wealth as number);
        eq += (u.wealth_equipments as number) ?? 0;
        wp += (u.wealth_weapons as number) ?? 0;
        it += (u.wealth_items as number) ?? 0;
        mo += (u.wealth_money as number) ?? 0;
        co += (u.wealth_companies as number) ?? 0;
        cnt++;
      }
    }
    search.push({
      type: 'mu', id: mu.id, name: mu.name ?? mu.id,
      memberCount: cnt, totalWealth: total,
      avgWealth: cnt > 0 ? Math.round((total / cnt) * 100) / 100 : 0,
      equipments: eq, weapons: wp, items: it, money: mo, companies: co,
      avgEquipments: cnt > 0 ? Math.round((eq / cnt) * 100) / 100 : 0,
      avgWeapons: cnt > 0 ? Math.round((wp / cnt) * 100) / 100 : 0,
      avgItems: cnt > 0 ? Math.round((it / cnt) * 100) / 100 : 0,
      avgMoney: cnt > 0 ? Math.round((mo / cnt) * 100) / 100 : 0,
      avgCompanies: cnt > 0 ? Math.round((co / cnt) * 100) / 100 : 0,
    });
  }

  // ── MU history (aggregated daily, in-memory from rawUserHist) ──
  for (const [muId, memberIds] of muMembership) {
    const tsMap = new Map<string, { total: number; eq: number; wp: number; it: number; mo: number; co: number; cnt: number }>();
    for (const uid of memberIds) {
      const entries = rawUserHist.get('user_' + uid);
      if (!entries) continue;
      for (const row of entries as any[]) {
        const ts = row.t;
        let e = tsMap.get(ts);
        if (!e) { e = { total: 0, eq: 0, wp: 0, it: 0, mo: 0, co: 0, cnt: 0 }; tsMap.set(ts, e); }
        e.total += row.total;
        e.eq += row.equipments;
        e.wp += row.weapons;
        e.it += row.items;
        e.mo += row.money;
        e.co += row.companies;
        e.cnt++;
      }
    }
    if (tsMap.size === 0) continue;
    const raw = [...tsMap.entries()]
      .map(([ts, d]) => ({
        t: ts, total: d.total, avg: d.total / d.cnt,
        members: d.cnt, equipments: d.eq, weapons: d.wp,
        items: d.it, money: d.mo, companies: d.co,
      }))
      .sort((a, b) => a.t.localeCompare(b.t));
    historyGroups['mu_' + muId] = removeDips(dailyAggregate(raw));
  }

  // ── Parties (search) ──
  const parties = db.prepare(
    `SELECT id, name, country_id, members FROM parties WHERE members IS NOT NULL`
  ).all() as Record<string, unknown>[];

  for (const party of parties) {
    const ids = parseMemberIds(party.members);
    if (ids.length === 0) continue;

    let total = 0, eq = 0, wp = 0, it = 0, mo = 0, co = 0, cnt = 0;
    for (const uid of ids) {
      const u = userWealthMap.get(uid);
      if (u) {
        total += (u.wealth as number);
        eq += (u.wealth_equipments as number) ?? 0;
        wp += (u.wealth_weapons as number) ?? 0;
        it += (u.wealth_items as number) ?? 0;
        mo += (u.wealth_money as number) ?? 0;
        co += (u.wealth_companies as number) ?? 0;
        cnt++;
      }
    }
    search.push({
      type: 'party', id: party.id, name: party.name ?? party.id, sub: party.country_id ?? null,
      memberCount: cnt, totalWealth: total,
      avgWealth: cnt > 0 ? Math.round((total / cnt) * 100) / 100 : 0,
      equipments: eq, weapons: wp, items: it, money: mo, companies: co,
      avgEquipments: cnt > 0 ? Math.round((eq / cnt) * 100) / 100 : 0,
      avgWeapons: cnt > 0 ? Math.round((wp / cnt) * 100) / 100 : 0,
      avgItems: cnt > 0 ? Math.round((it / cnt) * 100) / 100 : 0,
      avgMoney: cnt > 0 ? Math.round((mo / cnt) * 100) / 100 : 0,
      avgCompanies: cnt > 0 ? Math.round((co / cnt) * 100) / 100 : 0,
    });
  }

  // ── Party history (aggregated daily, in-memory from rawUserHist) ──
  for (const party of parties) {
    const ids = parseMemberIds(party.members);
    if (ids.length === 0) continue;
    const tsMap = new Map<string, { total: number; eq: number; wp: number; it: number; mo: number; co: number; cnt: number }>();
    for (const uid of ids) {
      const entries = rawUserHist.get('user_' + uid);
      if (!entries) continue;
      for (const row of entries as any[]) {
        const ts = row.t;
        let e = tsMap.get(ts);
        if (!e) { e = { total: 0, eq: 0, wp: 0, it: 0, mo: 0, co: 0, cnt: 0 }; tsMap.set(ts, e); }
        e.total += row.total;
        e.eq += row.equipments;
        e.wp += row.weapons;
        e.it += row.items;
        e.mo += row.money;
        e.co += row.companies;
        e.cnt++;
      }
    }
    if (tsMap.size === 0) continue;
    const raw = [...tsMap.entries()]
      .map(([ts, d]) => ({
        t: ts, total: d.total, avg: d.total / d.cnt,
        members: d.cnt, equipments: d.eq, weapons: d.wp,
        items: d.it, money: d.mo, companies: d.co,
      }))
      .sort((a, b) => a.t.localeCompare(b.t));
    historyGroups['party_' + party.id] = removeDips(dailyAggregate(raw));
  }

  console.log(`  Wealth data: ${search.length} entities, ${Object.keys(historyGroups).length} group + ${Object.keys(historyUsers).length} user keys (${Date.now() - t0}ms)`);
  return { search, historyGroups, historyUsers };
}

function loadWealthCountryHistory20(db: Database.Database): Record<string, unknown[]> {
  const rows = db.prepare(`
    SELECT uh.country, uh.fetched_at,
           COUNT(*) as cnt, SUM(uh.wealth) as total, AVG(uh.wealth) as avg,
           SUM(uh.wealth_equipments) as eq, SUM(uh.wealth_weapons) as wp,
           SUM(uh.wealth_items) as it, SUM(uh.wealth_money) as mo,
           SUM(uh.wealth_companies) as co
    FROM user_history uh
    JOIN users u ON u.id = uh.id AND u.level >= 20
    WHERE uh.fetched_at >= datetime('now', '-30 days')
    GROUP BY uh.country, uh.fetched_at
    ORDER BY uh.country, uh.fetched_at
  `).all() as Record<string, unknown>[];

  const raw = new Map<string, unknown[]>();
  for (const row of rows) {
    const key = 'country_' + row.country;
    (raw.get(key) ?? raw.set(key, []).get(key)!).push({
      t: (row.fetched_at as string).slice(0, 16),
      total: row.total,
      avg: Math.round((row.avg as number) * 100) / 100,
      members: row.cnt,
      equipments: row.eq ?? 0,
      weapons: row.wp ?? 0,
      items: row.it ?? 0,
      money: row.mo ?? 0,
      companies: row.co ?? 0,
    });
  }
  const result: Record<string, unknown[]> = {};
  for (const [key, entries] of raw) {
    result[key] = removeDips(dailyAggregate(entries as any[]));
  }
  console.log(`  Wealth country history (level 20+): ${Object.keys(result).length} countries`);
  return result;
}

function generateHtml(data: string, wealthSearchJson: string, wealthHistoryGroupsJson: string, wealthHistoryUsersJson: string, wealthCountryHistory20Json: string): string {
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Warera Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0d1117;color:#c9d1d9;padding:20px}
h1{font-size:24px;margin-bottom:20px;color:#f0f6fc}
nav{display:flex;gap:4px;border-bottom:1px solid #30363d}
nav button{background:none;border:none;color:#8b949e;padding:10px 20px;cursor:pointer;font-size:14px;border-bottom:2px solid transparent;transition:all .15s}
nav button:hover{color:#f0f6fc}
nav button.active{color:#f0f6fc;border-bottom-color:#58a6ff}
.main-nav{margin-bottom:20px}
.sub-nav{margin-bottom:16px}
.sub-nav button{padding:6px 14px;font-size:13px;border-bottom-width:1px}
.section{display:none}
.section.active{display:block}
.tab{display:none}
.tab.active{display:block}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:20px;margin-bottom:20px}
.card h2{font-size:18px;margin-bottom:16px;color:#f0f6fc}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:8px 12px;text-align:left;border-bottom:1px solid #21262d}
th{color:#8b949e;font-weight:600;cursor:pointer;user-select:none;position:relative}
th:hover{color:#f0f6fc}
th.sorted::after{content:' ▾';color:#58a6ff}
th.sorted.asc::after{content:' ▴'}
tr:hover td{background:#1c2128}
tr.top td{font-weight:600;color:#f0f6fc}
.bonus{color:#3fb950}
.malus{color:#f85149}
.pct{color:#d2a8ff}
.btc{color:#ffa657}
.occ{color:#8b949e;font-size:11px}
.slider-row{display:flex;align-items:center;gap:16px;margin-bottom:16px}
.slider-row label{color:#8b949e;font-size:14px}
.slider-row input[type=range]{width:240px;accent-color:#58a6ff}
.slider-row .val{color:#f0f6fc;font-weight:600;font-size:16px;min-width:48px}
.item-toggles{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px}
.item-toggles button{padding:4px 12px;border-radius:4px;border:1px solid #30363d;background:#0d1117;color:#8b949e;cursor:pointer;font-size:12px;transition:all .15s}
.item-toggles button.active{border-color:#58a6ff;color:#f0f6fc;background:#1c2128}
.item-toggles button:hover{border-color:#58a6ff}
.country-item{cursor:pointer;padding:6px 10px;border-radius:4px;color:#c9d1d9;font-size:13px;border-bottom:1px solid #21262d;transition:background .15s}
.country-item:hover{background:#1c2128}
.country-item.selected{background:#1c2128;color:#f0f6fc;font-weight:600;border-left:3px solid #58a6ff;padding-left:7px}
.chart-container{position:relative;height:60vh;width:100%}
.empty{color:#8b949e;text-align:center;padding:40px;font-size:14px}
.item-icon{width:22px;height:22px;vertical-align:middle;margin-right:6px;border-radius:3px;object-fit:contain}
.item-icon-sm{width:16px;height:16px;vertical-align:middle;margin-right:4px;border-radius:2px;object-fit:contain}
.color-dot{display:inline-block;width:10px;height:10px;border-radius:2px;vertical-align:middle;margin-right:4px}
.item-toggles button img.item-icon{width:18px;height:18px;margin-right:4px}
.item-toggles button.active img.item-icon{filter:brightness(1.2)}
h2 img.item-icon{width:24px;height:24px}
.card-grid{display:flex;gap:20px;flex-wrap:wrap}
.card-grid .card{flex:1;min-width:280px}
.change-delta{font-weight:600}
@media(max-width:768px){table{font-size:12px}th,td{padding:6px 8px}.chart-container{height:50vh}}
</style>
</head>
<body>
<h1>Warera Dashboard</h1>
<nav class="main-nav">
${SECTIONS.map((s, i) => `<button class="${i === 0 ? 'active' : ''}" data-section="${s.id}">${s.label}</button>`).join('')}
</nav>

${SECTIONS.map((s, si) => s.id === 'country-compare' ? `
<div id="section-country-compare" class="section${si === 0 ? ' active' : ''}">
<nav class="sub-nav">
${s.tabs.map((t, ti) => `<button class="${ti === 0 ? 'active' : ''}" data-tab="${t.id}">${t.label}</button>`).join('')}
</nav>

<div class="card">
<div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap;align-items:center">
<input type="text" id="ccSearch" placeholder="Land suchen..." style="background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:6px 12px;font-size:14px;width:200px">
<select id="ccAllianceSelect" style="background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:6px 12px;font-size:13px;cursor:pointer">
<option value="">— Allianz auswählen —</option>
</select>
<button id="ccSelectAll" style="background:#1c2128;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:6px 12px;cursor:pointer;font-size:13px">Alle auswählen</button>
<button id="ccDeselectAll" style="background:#1c2128;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:6px 12px;cursor:pointer;font-size:13px">Alle abwählen</button>
<span style="flex:1"></span>
</div>
<div style="max-height:240px;overflow-y:auto;border:1px solid #21262d;border-radius:4px" id="ccCountryList"></div>
</div>

${s.tabs.map(t => t.id === 'wealth' ? `
<div id="tab-wealth" class="tab active">
<div class="card">
<div style="display:flex;gap:12px;margin-bottom:16px;align-items:center;flex-wrap:wrap">
<span style="color:#8b949e;font-size:13px">Anzeige:</span>
<div style="display:inline-flex;border:1px solid #30363d;border-radius:4px;overflow:hidden">
<button id="ccModeTotal" style="background:#1c2128;color:#f0f6fc;border:none;padding:6px 14px;cursor:pointer;font-size:13px">Gesamtwerte</button>
<button id="ccModeAvg" style="background:transparent;color:#8b949e;border:none;padding:6px 14px;cursor:pointer;font-size:13px">Durchschnitt</button>
</div>
<label style="display:flex;align-items:center;gap:6px;color:#c9d1d9;font-size:13px;cursor:pointer">
<input type="checkbox" id="ccWealthLevelFilter" style="accent-color:#58a6ff"> Nur Level ≥ 20
</label>
</div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px" id="ccCharts">
<div class="card"><h2>Gesamtvermögen</h2><div class="chart-container" style="height:300px"><canvas id="ccChart0"></canvas></div></div>
<div class="card"><h2>Liquides Vermögen</h2><div class="chart-container" style="height:300px"><canvas id="ccChart1"></canvas></div></div>
<div class="card"><h2>Ausrüstung + Waffen</h2><div class="chart-container" style="height:300px"><canvas id="ccChart2"></canvas></div></div>
<div class="card"><h2>Equipment</h2><div class="chart-container" style="height:300px"><canvas id="ccChart3"></canvas></div></div>
<div class="card"><h2>Waffen</h2><div class="chart-container" style="height:300px"><canvas id="ccChart4"></canvas></div></div>
<div class="card"><h2>Items</h2><div class="chart-container" style="height:300px"><canvas id="ccChart5"></canvas></div></div>
<div class="card"><h2>Geld</h2><div class="chart-container" style="height:300px"><canvas id="ccChart6"></canvas></div></div>
<div class="card"><h2>Firmen</h2><div class="chart-container" style="height:300px"><canvas id="ccChart7"></canvas></div></div>
</div>
<div id="ccNoSelection" class="empty" style="display:none">Keine Länder ausgewählt</div>
` : '').join('')}
</div>` : `
<div id="section-${s.id}" class="section${si === 0 ? ' active' : ''}">
<nav class="sub-nav">
${s.tabs.map((t, ti) => `<button class="${ti === 0 ? 'active' : ''}" data-tab="${t.id}">${t.label}</button>`).join('')}
</nav>

${s.tabs.map(t => t.id === 'prices' ? `
<div id="tab-prices" class="tab${si === 0 ? ' active' : ''}">
<div class="card">
<h2>Item-Preise (letzte 30 Tage)</h2>
<div class="item-toggles" id="itemToggles"></div>
<div class="chart-container"><canvas id="priceChart"></canvas></div>
</div>
</div>` : t.id === 'production' ? `
<div id="tab-production" class="tab">
<div id="prodContent"></div>
</div>` : t.id === 'wages' ? `
<div id="tab-wages" class="tab">
<div class="card">
<h2>Lohn-Rechner</h2>
<div class="slider-row">
<label>Fidelity:</label>
<input type="range" id="fidelitySlider" min="0" max="10" value="0" step="1">
<span class="val" id="fidelityVal">0%</span>
<label style="margin-left:16px">Sortierung:</label>
<select id="wageSort" style="background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:4px 8px">
<option value="netto">Netto/PP</option>
<option value="brutto">Brutto/PP</option>
<option value="vk">VK</option>
<option value="ek">EK</option>
<option value="bonus">Total Bonus</option>
<option value="steuer">Steuer</option>
</select>
</div>
<div id="wageTableContainer"></div>
</div>
</div>` : t.id === 'overview' ? `
<div id="tab-overview" class="tab">
<div class="card">
<h2>Gesamtspielerzahl im Zeitverlauf</h2>
<div class="chart-container"><canvas id="playerChart"></canvas></div>
</div>
<div class="card-grid">
<div class="card">
<h2>Top 5 Anstieg (24h)</h2>
<table class="change-table" id="playerGainers"><thead><tr><th>#</th><th>Land</th><th>Vorher</th><th>Nachher</th><th>±</th></tr></thead><tbody></tbody></table>
</div>
<div class="card">
<h2>Top 5 Rückgang (24h)</h2>
<table class="change-table" id="playerLosers"><thead><tr><th>#</th><th>Land</th><th>Vorher</th><th>Nachher</th><th>±</th></tr></thead><tbody></tbody></table>
</div>
</div>
</div>` : t.id === 'search' ? `
<div id="tab-search" class="tab">
<div class="card">
<div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap">
<input type="text" id="wealthSearch" placeholder="Name oder ID eingeben..." style="flex:1;background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:6px 12px;font-size:14px;min-width:200px">
<span style="color:#8b949e;font-size:13px;align-self:center" id="wealthCount">0 Ergebnisse</span>
</div>
<div class="item-toggles" id="wealthTypeTabs">
<button class="active" data-type="all">Alle</button>
<button data-type="user">Spieler</button>
<button data-type="country">Länder</button>
<button data-type="mu">MUs</button>
<button data-type="party">Parteien</button>
</div>
<div style="overflow-x:auto"><table id="wealthResults"><thead><tr>
<th>TYP</th><th>NAME</th><th>LAND</th><th>MITGL.</th><th>GESAMT</th><th>Ø</th><th>EQ</th><th>Ø EQ</th><th>WAFFEN</th><th>Ø WAFFEN</th><th>ITEMS</th><th>Ø ITEMS</th><th>GELD</th><th>Ø GELD</th><th>FIRMEN</th><th>Ø FIRMEN</th>
</tr></thead><tbody></tbody></table></div>
</div>
<div class="card" id="wealthChartCard" style="display:none">
<h2 id="wealthChartTitle">Vermögensentwicklung</h2>
<div class="chart-container"><canvas id="wealthChart"></canvas></div>
</div>
</div>` : '').join('')}
</div>`).join('')}

<script>
var DATA = ${data};
var WEALTH_SEARCH = ${wealthSearchJson};
var WEALTH_HISTORY_GROUPS = ${wealthHistoryGroupsJson};
var WEALTH_HISTORY_USERS = ${wealthHistoryUsersJson};
var WEALTH_COUNTRY_HISTORY_20 = ${wealthCountryHistory20Json};
var ITEM_META = ${JSON.stringify(ITEM_META)};

// ── Main Section Navigation ──
document.querySelectorAll('.main-nav button').forEach(function(btn) {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.main-nav button').forEach(function(b){b.classList.remove('active')});
    document.querySelectorAll('.section').forEach(function(s){s.classList.remove('active')});
    btn.classList.add('active');
    var section = document.getElementById('section-' + btn.dataset.section);
    section.classList.add('active');
    var firstTab = section.querySelector('.sub-nav button');
    if (firstTab) firstTab.click();
  });
});

// ── Sub Tab Navigation ──
document.querySelectorAll('.sub-nav button').forEach(function(btn) {
  btn.addEventListener('click', function() {
    var section = btn.closest('.section');
    section.querySelectorAll('.sub-nav button').forEach(function(b){b.classList.remove('active')});
    section.querySelectorAll('.tab').forEach(function(t){t.classList.remove('active')});
    btn.classList.add('active');
    section.querySelector('#tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'wages') renderWages();
    if (btn.dataset.tab === 'overview') renderPlayerOverview();
    if (btn.dataset.tab === 'search') setTimeout(initWealth, 50);
    if (btn.dataset.tab === 'wealth') setTimeout(initCountryCompare, 50);

  });
});

// ── Price Chart ──
(function initPrices() {
  var ctx = document.getElementById('priceChart').getContext('2d');
  var rows = DATA.prices.rows;
  var items = DATA.prices.items;
  var labels = rows.map(function(r){return r.t});
  var datasets = [];
  var activeItems = {};
  items.forEach(function(code,i){
    activeItems[code] = i < 3;
    var hidden = i >= 3;
    var meta = ITEM_META[code] || {name: code, color: '#8b949e'};
    datasets.push({
      label: meta.name,
      data: rows.map(function(r){return r.v[i]}),
      borderColor: meta.color,
      backgroundColor: meta.color + '33',
      borderWidth: hidden ? 1 : 2,
      pointRadius: 0,
      tension: 0.1,
      hidden: hidden,
    });
  });
  var chart = new Chart(ctx, {
    type: 'line',
    data: { labels: labels, datasets: datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#161b22',
          titleColor: '#f0f6fc',
          bodyColor: '#c9d1d9',
          borderColor: '#30363d',
          borderWidth: 1,
        }
      },
      scales: {
        x: {
          ticks: { color: '#8b949e', maxTicksLimit: 10, maxRotation: 0 },
          grid: { color: '#21262d' }
        },
        y: {
          ticks: { color: '#8b949e', callback: function(v){return v+' BTC'} },
          grid: { color: '#21262d' }
        }
      }
    }
  });

  // Item toggles
  var container = document.getElementById('itemToggles');
  items.forEach(function(code,i){
    var meta = ITEM_META[code] || {name: code, color: '#8b949e'};
    var btn = document.createElement('button');
        var img = document.createElement('img');
    img.src = 'pictures/' + code + '.png';
    img.alt = '';
    img.className = 'item-icon';
    img.onerror = function() { this.style.display = 'none'; };
    btn.appendChild(img);
    btn.appendChild(document.createTextNode(' ' + meta.name));
    btn.dataset.index = i;
    if (activeItems[code]) btn.classList.add('active');
    btn.addEventListener('click', function(){
      var ds = chart.data.datasets[i];
      ds.hidden = !ds.hidden;
      ds.borderWidth = ds.hidden ? 1 : 2;
      btn.classList.toggle('active');
      chart.update();
    });
    container.appendChild(btn);
  });
})();

// ── Production Table ──
(function initProduction() {
  var container = document.getElementById('prodContent');
  var html = '';

  // Top 5 overall first
  if (DATA.production.topOverall && DATA.production.topOverall.length > 0) {
    html += '<div class="card"><h2>Top 5 Item/Country nach Profit/PP</h2>';
    html += '<table><thead><tr>';
    html += '<th>#</th><th>Item</th><th>Land</th><th>Region</th><th>Total</th><th>Profit/PP</th>';
    html += '</tr></thead><tbody>';
    DATA.production.topOverall.slice(0, 5).forEach(function(r,i){
      var occ = r.region && r.region.ci !== r.region.ic ? ' <span class="occ">(besetzt)</span>' : '';
      var reg = r.region ? r.region.rn + occ : '—';
      var mi = ITEM_META[r.item] || {name: r.item, color: '#8b949e'};
      html += '<tr class="top"><td>' + (i+1) + '</td>';
      html += '<td><span class="color-dot" style="background:' + mi.color + '"></span><img src="pictures/' + r.item + '.png" alt="" class="item-icon-sm" onerror="this.style.display=\\'none\\'"> ' + mi.name + '</td>';
      html += '<td>' + esc(r.c) + '</td>';
      html += '<td>' + reg + '</td>';
      html += '<td class="pct">' + r.tt + '%</td>';
      html += '<td class="btc">' + r.pp.toFixed(3) + ' BTC</td></tr>';
    });
    html += '</tbody></table></div>';
  }

  DATA.production.items.forEach(function(item){
    var ranking = DATA.production.rankings[item];
    if (!ranking || ranking.length === 0) return;
    var mi = ITEM_META[item] || {name: item, color: '#8b949e'};
    html += '<div class="card"><h2><span class="color-dot" style="background:' + mi.color + '"></span><img src="pictures/' + item + '.png" alt="" class="item-icon" onerror="this.style.display=\\'none\\'"> ' + mi.name + ' <span style="color:#8b949e;font-size:14px;font-weight:400">(' + item + ')</span></h2>';
    html += '<table><thead><tr>';
    html += '<th data-sort="rang">#</th>';
    html += '<th data-sort="country">Land</th>';
    html += '<th data-sort="region">Region</th>';
    html += '<th data-sort="dep">Dep</th>';
    html += '<th data-sort="sr">SR</th>';
    html += '<th data-sort="ethic">Ethik</th>';
    html += '<th data-sort="total">Total</th>';
    html += '<th data-sort="ppp">Profit/PP</th>';
    html += '</tr></thead><tbody>';
    ranking.forEach(function(r,i){
      var occ = r.region && r.region.ci !== r.region.ic ? ' <span class="occ">(besetzt)</span>' : '';
      var reg = r.region ? r.region.rn + occ : '—';
      html += '<tr' + (i < 5 ? ' class="top"' : '') + '>';
      html += '<td>' + (i + 1) + '</td>';
      html += '<td>' + esc(r.c) + '</td>';
      html += '<td>' + reg + '</td>';
      html += '<td class="' + (r.db > 0 ? 'bonus' : '') + '">' + r.db + '%</td>';
      html += '<td class="' + (r.sb > 0 ? 'bonus' : '') + '">' + r.sb + '%</td>';
      html += '<td class="' + (r.eb > 0 ? 'bonus' : '') + '">' + r.eb + '%</td>';
      html += '<td class="pct">' + r.tt + '%</td>';
      html += '<td class="btc">' + r.pp.toFixed(3) + ' BTC</td>';
      html += '</tr>';
    });
    html += '</tbody></table></div>';
  });

  container.innerHTML = html;

  // Column sorting
  container.querySelectorAll('th[data-sort]').forEach(function(th){
    th.addEventListener('click', function(){
      var table = th.closest('table');
      var tbody = table.querySelector('tbody');
      var rows = Array.from(tbody.querySelectorAll('tr'));
      var key = th.dataset.sort;
      var isAsc = th.classList.contains('sorted') && !th.classList.contains('asc');
      th.closest('tr').querySelectorAll('th').forEach(function(h){h.classList.remove('sorted','asc')});
      th.classList.add('sorted');
      if (isAsc) th.classList.add('asc');
      rows.sort(function(a,b){
        var va = a.children[Array.from(th.parentNode.children).indexOf(th)].textContent.trim();
        var vb = b.children[Array.from(th.parentNode.children).indexOf(th)].textContent.trim();
        var na = parseFloat(va), nb = parseFloat(vb);
        if (!isNaN(na) && !isNaN(nb)) return isAsc ? na - nb : nb - na;
        return isAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      });
      rows.forEach(function(r){tbody.appendChild(r)});
    });
  });
})();

// ── Wages ──
function renderWages() {
  var fidelity = parseInt(document.getElementById('fidelitySlider').value);
  var sortBy = document.getElementById('wageSort').value;
  document.getElementById('fidelityVal').textContent = fidelity + '%';

  var entries = DATA.wages.entries.map(function(e){
    var totalBonus = e.tb + fidelity;
    var grossWage = Math.round(e.bp * (1 + totalBonus / 100) * 1000) / 1000;
    var netWage = Math.round(grossWage * (1 - e.tx / 100) * 1000) / 1000;
    return { item: e.i, country: e.c, region: e.reg, depositDisplay: e.dd, sellPrice: e.sp, inputCost: e.ic, totalBonus: totalBonus, baseProfitPerPP: e.bp, grossWage: grossWage, taxIncome: e.tx, netWage: netWage };
  });

  entries.sort(function(a,b){
    switch(sortBy) {
      case 'brutto': return b.grossWage - a.grossWage;
      case 'vk': return b.sellPrice - a.sellPrice;
      case 'ek': return b.inputCost - a.inputCost;
      case 'bonus': return b.totalBonus - a.totalBonus;
      case 'steuer': return a.taxIncome - b.taxIncome;
      default: return b.netWage - a.netWage;
    }
  });

  var top = entries.slice(0, 30);
  var html = '<table><thead><tr>';
  html += '<th>#</th><th>Item</th><th>Land</th><th>Region</th><th>VK</th><th>EK</th><th>Bonus</th><th>Dep</th><th>Brutto/PP</th><th>Steuer</th><th>Netto/PP</th>';
  html += '</tr></thead><tbody>';
  top.forEach(function(r,i){
    var occ = r.region && r.region.ci !== r.region.ic ? ' <span class="occ">(besetzt)</span>' : '';
    var reg = r.region ? r.region.rn + occ : '—';
    var mi = ITEM_META[r.item] || {name: r.item, color: '#8b949e'};
    html += '<tr' + (i === 0 ? ' class="top"' : '') + '>';
    html += '<td>' + (i+1) + '</td>';
    html += '<td><span class="color-dot" style="background:' + mi.color + '"></span><img src="pictures/' + r.item + '.png" alt="" class="item-icon-sm" onerror="this.style.display=\\'none\\'"> ' + mi.name + '</td>';
    html += '<td>' + esc(r.country) + '</td>';
    html += '<td>' + reg + '</td>';
    html += '<td class="btc">' + r.sellPrice.toFixed(3) + '</td>';
    html += '<td class="btc">' + r.inputCost.toFixed(3) + '</td>';
    html += '<td class="pct">' + r.totalBonus.toFixed(1) + '%</td>';
    html += '<td>' + r.depositDisplay + '</td>';
    html += '<td class="btc">' + r.grossWage.toFixed(3) + ' BTC</td>';
    html += '<td class="' + (r.taxIncome > 0 ? 'malus' : '') + '">' + r.taxIncome.toFixed(1) + '%</td>';
    html += '<td class="btc">' + r.netWage.toFixed(3) + ' BTC</td>';
    html += '</tr>';
  });
  html += '</tbody></table>';
  document.getElementById('wageTableContainer').innerHTML = html;
}

document.getElementById('fidelitySlider').addEventListener('input', renderWages);
document.getElementById('wageSort').addEventListener('change', renderWages);

// ── Player Overview ──
var playerInit = false;
function renderPlayerOverview() {
  if (playerInit) return;
  playerInit = true;
  var pd = DATA.players;
  if (!pd || !pd.timeline || pd.timeline.length === 0) return;

  var ctx = document.getElementById('playerChart').getContext('2d');
  new Chart(ctx, {
    type: 'line',
    data: {
      labels: pd.timeline.map(function(r){return (r.t || '').slice(0,16)}),
      datasets: [{
        label: 'Spieler',
        data: pd.timeline.map(function(r){return r.total}),
        borderColor: '#58a6ff',
        backgroundColor: '#58a6ff22',
        fill: true,
        pointRadius: 2,
        tension: 0.1,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#161b22',
          titleColor: '#f0f6fc',
          bodyColor: '#c9d1d9',
          borderColor: '#30363d',
          borderWidth: 1,
        }
      },
      scales: {
        x: { ticks: { color: '#8b949e', maxTicksLimit: 15, maxRotation: 0 }, grid: { color: '#21262d' } },
        y: { ticks: { color: '#8b949e' }, grid: { color: '#21262d' } }
      }
    }
  });

  renderChangeTable('playerGainers', pd.gainers, true);
  renderChangeTable('playerLosers', pd.losers, false);
}

function renderChangeTable(id, data, isGainer) {
  var tbody = document.getElementById(id).querySelector('tbody');
  if (!data || data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">Keine Daten</td></tr>';
    return;
  }
  var html = '';
  data.forEach(function(r, i){
    var delta = r.delta > 0 ? '+' + r.delta : '' + r.delta;
    var cls = r.delta > 0 ? 'bonus' : 'malus';
    html += '<tr' + (i < 1 ? ' class="top"' : '') + '>';
    html += '<td>' + (i + 1) + '</td>';
    html += '<td>' + esc(r.country) + '</td>';
    html += '<td>' + r.before + '</td>';
    html += '<td>' + r.after + '</td>';
    html += '<td class="change-delta ' + cls + '">' + delta + '</td>';
    html += '</tr>';
  });
  tbody.innerHTML = html;
}

// ── Wealth Search ──
var wealthHistoryGroups = null;
var wealthHistoryUsers = null;
var wealthChart = null;
var wealthTypeFilter = 'all';

function initWealth() {
  var tab = document.getElementById('tab-search');
  if (!tab || !tab.classList.contains('active')) return;

  if (!WEALTH_SEARCH) return;

  document.getElementById('wealthSearch').addEventListener('input', renderWealthResults);

  // Type tab click handlers
  document.querySelectorAll('#wealthTypeTabs button').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('#wealthTypeTabs button').forEach(function(b){b.classList.remove('active')});
      btn.classList.add('active');
      wealthTypeFilter = btn.dataset.type;
      renderWealthResults();
    });
  });

  wealthHistoryGroups = WEALTH_HISTORY_GROUPS;

  renderWealthResults();
}

function getWealthTypeLabel(type) {
  return { user: 'Spieler', country: 'Land', mu: 'MU', party: 'Partei' }[type] || type;
}

function wealthGetHistory(key, entity, callback) {
  var h = wealthHistoryGroups ? wealthHistoryGroups[key] : null;
  if (h) { callback(h); return; }
  if (entity && entity.type === 'user') {
    callback(wealthHistoryUsers ? wealthHistoryUsers[key] || null : null);
  } else {
    callback(null);
  }
}

function renderWealthResults() {
  if (!WEALTH_SEARCH) return;
  var query = document.getElementById('wealthSearch').value.toLowerCase().trim();
  var results = WEALTH_SEARCH.filter(function(e) {
    if (wealthTypeFilter !== 'all' && e.type !== wealthTypeFilter) return false;
    if (query && e.name.toLowerCase().indexOf(query) === -1 && e.id.toLowerCase().indexOf(query) === -1) return false;
    return true;
  }).slice(0, 500);
  document.getElementById('wealthCount').textContent = results.length + ' Ergebnisse' + (results.length === 500 ? ' (max 500)' : '');

  var tbody = document.querySelector('#wealthResults tbody');
  var html = '';
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    var sub = r.sub || '';
    html += '<tr style="cursor:pointer" data-key="' + r.type + '_' + r.id + '">';
    html += '<td><span class="color-dot" style="background:' + ({user:'#58a6ff',country:'#3fb950',mu:'#d97706',party:'#a855f7'}[r.type] || '#8b949e') + '"></span>' + getWealthTypeLabel(r.type) + '</td>';
    html += '<td>' + esc(r.name) + '</td>';
    html += '<td>' + esc(sub) + '</td>';
    html += '<td>' + r.memberCount + '</td>';
    html += '<td class="btc">' + fmt(r.totalWealth || 0, 2, true) + '</td>';
    html += '<td class="btc">' + fmt(r.avgWealth || 0, 2, true) + '</td>';
    html += '<td class="btc">' + fmt(r.equipments || 0, 2, true) + '</td>';
    html += '<td class="btc">' + fmt(r.avgEquipments || 0, 2, true) + '</td>';
    html += '<td class="btc">' + fmt(r.weapons || 0, 2, true) + '</td>';
    html += '<td class="btc">' + fmt(r.avgWeapons || 0, 2, true) + '</td>';
    html += '<td class="btc">' + fmt(r.items || 0, 2, true) + '</td>';
    html += '<td class="btc">' + fmt(r.avgItems || 0, 2, true) + '</td>';
    html += '<td class="btc">' + fmt(r.money || 0, 2, true) + '</td>';
    html += '<td class="btc">' + fmt(r.avgMoney || 0, 2, true) + '</td>';
    html += '<td class="btc">' + fmt(r.companies || 0, 2, true) + '</td>';
    html += '<td class="btc">' + fmt(r.avgCompanies || 0, 2, true) + '</td>';
    html += '</tr>';
  }
  if (results.length === 0) {
    html = '<tr><td colspan="16" class="empty">Keine Ergebnisse</td></tr>';
  }
  tbody.innerHTML = html;

  // Click handler for chart
  tbody.querySelectorAll('tr[data-key]').forEach(function(row) {
    row.addEventListener('click', function() {
      var key = row.dataset.key;
      var entity = results.find(function(r){ return r.type + '_' + r.id === key; });
      renderWealthChart(key, entity);
    });
  });
}

function renderWealthChart(key, entity) {
  wealthGetHistory(key, entity, function(history) {
    var card = document.getElementById('wealthChartCard');
    var title = document.getElementById('wealthChartTitle');
    if (!history || history.length < 2) {
      card.style.display = 'none';
      return;
    }
    card.style.display = 'block';
    title.textContent = 'Vermögensentwicklung – ' + esc(entity ? entity.name : key);

    var colors = [
      { key: 'avg',        label: 'Gesamt',     border: '#58a6ff', bg: '#58a6ff22' },
      { key: 'equipments', label: 'Equipment',  border: '#d97706', bg: '#d9770622' },
      { key: 'weapons',    label: 'Waffen',     border: '#ef4444', bg: '#ef444422' },
      { key: 'items',      label: 'Items',      border: '#a855f7', bg: '#a855f722' },
      { key: 'money',      label: 'Geld',       border: '#3fb950', bg: '#3fb95022' },
      { key: 'companies',  label: 'Firmen',     border: '#f97316', bg: '#f9731622' },
    ];

    function getVal(h, k) {
      if (k === 'avg') return h.avg || 0;
      return (h[k] || 0) / (h.members || 1);
    }

    var ctx = document.getElementById('wealthChart').getContext('2d');
    if (wealthChart) wealthChart.destroy();
    wealthChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: history.map(function(h){return h.t}),
        datasets: colors.map(function(c) {
          return {
            label: c.label,
            data: history.map(function(h){return getVal(h, c.key)}),
            borderColor: c.border,
            backgroundColor: c.bg,
            fill: c.key === 'avg',
            pointRadius: 2,
            tension: 0.1,
          };
        }),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            labels: { color: '#8b949e' }
          },
          tooltip: {
            backgroundColor: '#161b22',
            titleColor: '#f0f6fc',
            bodyColor: '#c9d1d9',
            borderColor: '#30363d',
            borderWidth: 1,
            callbacks: {
              label: function(ctx) {
                return ctx.dataset.label + ': ' + fmt(ctx.parsed.y, 2, true) + ' BTC';
              }
            }
          }
        },
        scales: {
          x: { ticks: { color: '#8b949e', maxTicksLimit: 10, maxRotation: 0 }, grid: { color: '#21262d' } },
          y: {
            ticks: { color: '#8b949e' },
            grid: { color: '#21262d' },
            title: { display: true, text: 'BTC', color: '#8b949e' }
          }
        }
      }
    });
  });
}

// ── Country Comparison ──
var ccWealthMinLevel = false;
var ccCharts = [];
var ccCategories = [
  { key: 'total', label: 'Gesamtvermögen', totalKey: 'total', avgKey: 'avg' },
  { key: 'liquid', label: 'Liquides Vermögen', totalKey: 'liquid', avgKey: 'liquid' },
  { key: 'equipWeps', label: 'Ausrüstung + Waffen', totalKey: 'equipWeps', avgKey: 'equipWeps' },
  { key: 'equipments', label: 'Equipment', totalKey: 'equipments', avgKey: 'equipments' },
  { key: 'weapons', label: 'Waffen', totalKey: 'weapons', avgKey: 'weapons' },
  { key: 'items', label: 'Items', totalKey: 'items', avgKey: 'items' },
  { key: 'money', label: 'Geld', totalKey: 'money', avgKey: 'money' },
  { key: 'companies', label: 'Firmen', totalKey: 'companies', avgKey: 'companies' },
];
var ccPalette = [
  '#58a6ff','#3fb950','#d97706','#a855f7','#ef4444',
  '#f97316','#22c55e','#06b6d4','#e11d48','#8b5cf6',
  '#14b8a6','#f59e0b','#84cc16','#ec4899','#6366f1',
  '#0ea5e9','#fb923c','#a3e635','#f472b6','#2dd4bf',
];
var ccSelected = new Set();

function populateAlliances() {
  var sel = document.getElementById('ccAllianceSelect');
  if (!sel || sel.dataset.populated) return;
  sel.dataset.populated = '1';
  (DATA.alliances || []).forEach(function(a) {
    var opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.name + ' (' + a.memberCountries.length + ' Länder)';
    sel.appendChild(opt);
  });
  sel.addEventListener('change', function() {
    var id = this.value;
    if (!id) return;
    var alliance = (DATA.alliances || []).find(function(a) { return a.id === id; });
    if (!alliance) return;
    var list = document.getElementById('ccCountryList');
    list.querySelectorAll('.country-item').forEach(function(el) {
      var isMember = alliance.memberCountries.indexOf(el.dataset.id) !== -1;
      if (isMember) {
        el.classList.add('selected');
        el.querySelector('.cci').textContent = '\u2713';
        ccSelected.add(el.dataset.id);
      }
    });
    updateCountryCharts();
  });
}

function populateCountryList() {
  if (!DATA.countries) return;
  if (document.getElementById('ccCountryList').children.length > 0) return;

  var list = document.getElementById('ccCountryList');
  DATA.countries.forEach(function(c) {
    var val = getLatestWealthStr(c.id, getCCMode());
    var div = document.createElement('div');
    div.className = 'country-item';
    div.innerHTML = '<span class="cci" style="display:inline-block;width:16px;color:#58a6ff"> </span>' + esc(c.name) + ' <span class="ccw" style="float:right;color:#8b949e;font-size:11px">' + (val ? '— ' + val : '') + '</span>';
    div.dataset.id = c.id;
    div.dataset.name = c.name.toLowerCase();
    div.addEventListener('click', function() {
      var id = this.dataset.id;
      this.classList.toggle('selected');
      var indicator = this.querySelector('.cci');
      if (this.classList.contains('selected')) {
        ccSelected.add(id);
        indicator.textContent = '\u2713';
      } else {
        ccSelected.delete(id);
        indicator.textContent = ' ';
      }
      updateCountryCharts();
    });
    list.appendChild(div);
  });

  document.getElementById('ccSearch').addEventListener('input', function() {
    var q = this.value.toLowerCase();
    list.querySelectorAll('.country-item').forEach(function(el) {
      el.style.display = el.dataset.name.indexOf(q) === -1 ? 'none' : '';
    });
  });

  document.getElementById('ccSelectAll').addEventListener('click', function() {
    list.querySelectorAll('.country-item').forEach(function(el) {
      if (el.style.display !== 'none') {
        el.classList.add('selected');
        el.querySelector('.cci').textContent = '\u2713';
        ccSelected.add(el.dataset.id);
      }
    });
    updateCountryCharts();
  });

  document.getElementById('ccDeselectAll').addEventListener('click', function() {
    list.querySelectorAll('.country-item').forEach(function(el) {
      el.classList.remove('selected');
      el.querySelector('.cci').textContent = ' ';
    });
    ccSelected.clear();
    updateCountryCharts();
  });
}

function initCountryCompare() {
  populateCountryList();
  populateAlliances();
  var tab = document.getElementById('tab-wealth');
  if (!tab || !tab.classList.contains('active')) return;

  function setMode(mode) {
    var totalBtn = document.getElementById('ccModeTotal');
    var avgBtn = document.getElementById('ccModeAvg');
    if (mode === 'avg') {
      avgBtn.style.background = '#1c2128'; avgBtn.style.color = '#f0f6fc';
      totalBtn.style.background = 'transparent'; totalBtn.style.color = '#8b949e';
    } else {
      totalBtn.style.background = '#1c2128'; totalBtn.style.color = '#f0f6fc';
      avgBtn.style.background = 'transparent'; avgBtn.style.color = '#8b949e';
    }
    updateCountryCharts();
  }
  document.getElementById('ccModeTotal').addEventListener('click', function() { setMode('total'); });
  document.getElementById('ccModeAvg').addEventListener('click', function() { setMode('avg'); });
  document.getElementById('ccWealthLevelFilter').addEventListener('change', function() {
    ccWealthMinLevel = this.checked;
    updateCountryCharts();
  });
}

function getCCMode() {
  return document.getElementById('ccModeAvg').style.background === 'rgb(28, 33, 40)' ? 'avg' : 'total';
}

function fmt(n, decimals, abbreviate) {
  if (abbreviate && Math.abs(n) >= 1000000) {
    return (n / 1000000).toFixed(1).replace('.', ',') + ' M';
  }
  return new Intl.NumberFormat('de-DE', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n);
}

function getCCValue(entry, mode, cat) {
  if (cat.totalKey === 'liquid') {
    var sum = (entry.equipments || 0) + (entry.weapons || 0) + (entry.money || 0) + (entry.items || 0);
    return mode === 'total' ? sum : sum / (entry.members || 1);
  }
  if (cat.totalKey === 'equipWeps') {
    var sum = (entry.equipments || 0) + (entry.weapons || 0);
    return mode === 'total' ? sum : sum / (entry.members || 1);
  }
  if (mode === 'total') return entry[cat.totalKey] || 0;
  if (cat.avgKey === 'avg') return entry.avg || 0;
  return ((entry[cat.avgKey] || 0) / (entry.members || 1));
}

function getLatestWealthStr(id, mode) {
  var groups = ccWealthMinLevel ? (WEALTH_COUNTRY_HISTORY_20 || {}) : WEALTH_HISTORY_GROUPS;
  var hist = groups['country_' + id];
  if (!hist || hist.length === 0) return null;
  var last = hist[hist.length - 1];
  var liquid = (last.equipments || 0) + (last.weapons || 0) + (last.money || 0) + (last.items || 0);
  var val = mode === 'total' ? liquid : liquid / (last.members || 1);
  return (isFinite(val)) ? fmt(val, 1, true) + ' BTC' : null;
}

function refreshCountryWealthLabels() {
  var mode = getCCMode();
  document.querySelectorAll('#ccCountryList .country-item').forEach(function(el) {
    var span = el.querySelector('.ccw');
    if (span) {
      var val = getLatestWealthStr(el.dataset.id, mode);
      span.textContent = val ? '— ' + val : '';
    }
  });
  var sel = document.getElementById('ccAllianceSelect');
  if (sel && sel.value) {
    var alliance = (DATA.alliances || []).find(function(a) { return a.id === sel.value; });
    if (alliance) {
      var groups = ccWealthMinLevel ? (WEALTH_COUNTRY_HISTORY_20 || {}) : WEALTH_HISTORY_GROUPS;
      var total = 0;
      alliance.memberCountries.forEach(function(cid) {
        var hist = groups['country_' + cid];
        if (hist && hist.length > 0) {
          var last = hist[hist.length - 1];
          total += (last.equipments || 0) + (last.weapons || 0) + (last.money || 0) + (last.items || 0);
        }
      });
      sel.options[sel.selectedIndex].text = alliance.name + ' (' + alliance.memberCountries.length + ' Länder) — ' + fmt(total, 1, true) + ' BTC';
    }
  }
}

function updateCountryCharts() {
  var groups = ccWealthMinLevel ? (WEALTH_COUNTRY_HISTORY_20 || {}) : WEALTH_HISTORY_GROUPS;
  var noSel = document.getElementById('ccNoSelection');
  var chartsDiv = document.getElementById('ccCharts');
  var mode = getCCMode();
  var selected = [...ccSelected].filter(function(id) { return groups['country_' + id]; });

  if (selected.length === 0) {
    noSel.style.display = 'block';
    chartsDiv.style.display = 'none';
    refreshCountryWealthLabels();
    return;
  }
  noSel.style.display = 'none';
  chartsDiv.style.display = 'grid';

  var colorMap = {};
  selected.forEach(function(id, i) { colorMap[id] = ccPalette[i % ccPalette.length]; });

  var countryNameMap = {};
  DATA.countries.forEach(function(c) { countryNameMap[c.id] = c.name; });

  ccCategories.forEach(function(cat, ci) {
    var canvas = document.getElementById('ccChart' + ci);
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    if (ccCharts[ci]) { ccCharts[ci].destroy(); ccCharts[ci] = null; }

    var allLabels = new Set();
    var countryData = {};
    selected.forEach(function(id) {
      var hist = groups['country_' + id];
      if (!hist || hist.length === 0) return;
      countryData[id] = hist;
      hist.forEach(function(h) { allLabels.add(h.t); });
    });
    var labels = [...allLabels].sort();

    var datasets = [];
    selected.forEach(function(id, idx) {
      var hist = countryData[id];
      if (!hist) return;
      datasets.push({
        label: countryNameMap[id] || id,
        data: labels.map(function(t) {
          var entry = hist.find(function(h) { return h.t === t; });
          return entry ? getCCValue(entry, mode, cat) : null;
        }),
        borderColor: ccPalette[idx % ccPalette.length],
        backgroundColor: ccPalette[idx % ccPalette.length] + '33',
        fill: false,
        pointRadius: 2,
        tension: 0.1,
        spanGaps: true,
      });
    });

    ccCharts[ci] = new Chart(ctx, {
      type: 'line',
      data: { labels: labels, datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            labels: { color: '#8b949e', boxWidth: 12, padding: 8, font: { size: 11 } }
          },
          tooltip: {
            backgroundColor: '#161b22',
            titleColor: '#f0f6fc',
            bodyColor: '#c9d1d9',
            borderColor: '#30363d',
            borderWidth: 1,
            callbacks: {
              label: function(ctx) {
                return ctx.dataset.label + ': ' + fmt(ctx.parsed.y, 2, true) + ' BTC';
              }
            }
          }
        },
        scales: {
          x: { ticks: { color: '#8b949e', maxTicksLimit: 8, maxRotation: 0, font: { size: 10 } }, grid: { color: '#21262d' } },
          y: {
            ticks: { color: '#8b949e', font: { size: 10 } },
            grid: { color: '#21262d' },
            title: { display: true, text: 'BTC', color: '#8b949e', font: { size: 11 } }
          }
        }
      }
    });
  });
  refreshCountryWealthLabels();
}

function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
</script>
</body>
</html>`;
}

function loadAlliances(db: Database.Database): Array<{ id: string; name: string; memberCountries: string[] }> {
  const rows = db.prepare(`
    SELECT id, name, member_countries
    FROM alliances
    WHERE is_disbanded = 0 AND member_countries IS NOT NULL
    ORDER BY name
  `).all() as { id: string; name: string; member_countries: string | null }[];
  return rows.map(r => {
    let ids: string[] = [];
    if (r.member_countries) {
      const parsed = JSON.parse(r.member_countries) as unknown[];
      ids = parsed.map((m: any) => typeof m === 'string' ? m : m.country).filter(Boolean);
    }
    return { id: r.id, name: r.name, memberCountries: ids };
  }).filter(a => a.memberCountries.length > 0);
}

function main() {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  const config = loadConfig();
  const prodData = loadProdData(db);
  const countriesMap = loadCountriesData(db);

  // ── Prices ──
  const priceRows = loadPriceHistory(db);
  const itemCodes = Object.keys(ITEM_META);
  const priceData = {
    items: itemCodes,
    rows: priceRows.map(r => ({
      t: (r.fetched_at as string).slice(0, 16),
      v: itemCodes.map(code => (r[code] as number) ?? 0),
    })),
  };

  // ── Production Rankings ──
  const prodRankings: Record<string, unknown[]> = {};
  const topOverall: Array<{ item: string; c: string; region: RegionRow | null; tt: number; pp: number }> = [];

  for (const item of prodData.items) {
    const def = prodData.prod[item];
    if (!def) continue;
    const rankings = buildRankings(item, countriesMap, config, prodData.prod, prodData.prices);
    const filtered = rankings.filter(r => r.total > 0);
    if (filtered.length === 0) continue;

    prodRankings[item] = filtered.map(r => ({
      c: r.country,
      region: r.region ? { rn: r.region.region_name, ci: r.region.country_id, ic: r.region.initial_country } : null,
      db: r.depositBonus,
      sb: r.strategicBonus,
      eb: r.ethicBonus,
      tt: r.total,
      pp: r.profitPerPP,
    }));

    topOverall.push({
      item,
      c: filtered[0].country,
      region: filtered[0].region ? { rn: filtered[0].region.region_name, ci: filtered[0].region.country_id, ic: filtered[0].region.initial_country } : null,
      tt: filtered[0].total,
      pp: filtered[0].profitPerPP,
    });
  }

  topOverall.sort((a, b) => b.pp - a.pp);
  const topOverallData = topOverall.slice(0, 5).map(r => ({
    item: r.item,
    c: r.c,
    region: r.region,
    tt: r.tt,
    pp: r.pp,
  }));

  // ── Wages Data (raw entries for client-side fidelity calc) ──
  const wageEntries: Array<{
    i: string;
    c: string;
    reg: { rn: string; ci: string; ic: string } | null;
    dd: string;
    sp: number;
    ic: number;
    tb: number;
    bp: number;
    tx: number;
  }> = [];

  for (const item of prodData.items) {
    const base = computeBaseProfitPerPP(item, prodData.prod, prodData.prices);
    if (base <= 0) continue;
    const def = prodData.prod[item];
    const sellPrice = prodData.prices[item] ?? 0;
    let inputCost = 0;
    if (def && !def.isDeposit && def.productionNeeds) {
      for (const [inputCode, qty] of Object.entries(def.productionNeeds)) {
        inputCost += (prodData.prices[inputCode] ?? 0) * qty;
      }
    }

    for (const [, country] of countriesMap) {
      const bestRegion = pickBestRegion(country.regions, item);
      const depositMatch = country.regions.some(r => getDepositType(r.deposit) === item);
      const strategicBonus = country.specialized_item === item ? country.strategic_prod_bonus : 0;
      const ethicBonus = computeEthicBonus(item, country.ethics_industrialism, country.specialized_item, config);
      const totalBonus = (depositMatch ? config.deposit.bonusPercent : 0) + strategicBonus + ethicBonus;

      wageEntries.push({
        i: item,
        c: country.name,
        reg: bestRegion ? { rn: bestRegion.region_name, ci: bestRegion.country_id, ic: bestRegion.initial_country } : null,
        dd: getDepositDuration(bestRegion, item),
        sp: Math.round(sellPrice * 1000) / 1000,
        ic: Math.round(inputCost * 1000) / 1000,
        tb: Math.round(totalBonus * 10) / 10,
        bp: Math.round(base * 1000) / 1000,
        tx: country.tax_income,
      });
    }
  }

  // ── Player Data ──
  const playerData = loadPlayerData(db);

  // ── Wealth Data ──
  const wealthData = loadWealthData(db);

  // ── All Countries (for country comparison UI) ──
  const allCountries = db.prepare('SELECT id, name FROM countries ORDER BY name').all() as { id: string; name: string }[];

  // ── Serialize ──
  const jsonData = JSON.stringify({
    prices: priceData,
    production: {
      items: Object.keys(prodRankings).sort(),
      rankings: prodRankings,
      topOverall: topOverallData,
    },
    wages: {
      entries: wageEntries,
    },
    players: {
      timeline: playerData.timeline,
      gainers: playerData.gainers,
      losers: playerData.losers,
    },
    countries: allCountries,
    alliances: loadAlliances(db),
  });

  // ── Write wealth JSON files (loaded via fetch in browser) ──
  const dataDir = path.join(outDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'wealth-search.json'), JSON.stringify(wealthData.search), 'utf-8');
  fs.writeFileSync(path.join(dataDir, 'wealth-history-groups.json'), JSON.stringify(wealthData.historyGroups), 'utf-8');
  fs.writeFileSync(path.join(dataDir, 'wealth-history-users.json'), JSON.stringify(wealthData.historyUsers), 'utf-8');

  // ── Wealth Country History (Level 20+) ──
  const wealthCountryHistory20 = loadWealthCountryHistory20(db);

  // ── Generate HTML ──
  fs.mkdirSync(outDir, { recursive: true });
  const html = generateHtml(jsonData, JSON.stringify(wealthData.search), JSON.stringify(wealthData.historyGroups), JSON.stringify(wealthData.historyUsers), JSON.stringify(wealthCountryHistory20));
  fs.writeFileSync(outFile, html, 'utf-8');
  console.log(`Dashboard written to ${outFile}`);
  console.log(`  Prices:   ${priceData.rows.length} rows, ${priceData.items.length} items`);
  console.log(`  Production: ${Object.keys(prodRankings).length} items ranked`);
  console.log(`  Wages:    ${wageEntries.length} country/item combinations`);
  console.log(`  Players:  ${playerData.timeline.length} snapshots, ${playerData.gainers.length} gainers, ${playerData.losers.length} losers`);
  console.log(`  Wealth:   ${wealthData.search.length} entities, ${Object.keys(wealthData.historyGroups).length} group + ${Object.keys(wealthData.historyUsers).length} user history keys`);

  db.close();
}

main();
