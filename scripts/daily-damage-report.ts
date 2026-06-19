import 'dotenv/config';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const dataDir = path.resolve(process.env.SCRAPER_DATA_DIR || path.join(ROOT, 'data'));
const dbPath = path.join(dataDir, 'warera.db');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

function fmtDamage(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(Math.round(n));
}

interface AllianceMember {
  country: string;
}

interface AllianceRow {
  name: string;
  member_countries: string;
}

interface BattleRoundRow {
  battle_id: string;
  attacker_country: string;
  defender_country: string;
  day: string;
  number: number;
  attacker_damages: number;
  defender_damages: number;
}

function main() {
  const today = new Date().toISOString().slice(0, 10);
  const yesterdayDate = new Date(Date.now() - 86400000);
  const yesterday = yesterdayDate.toISOString().slice(0, 10);

  const alliances = db.prepare('SELECT name, member_countries FROM alliances').all() as AllianceRow[];

  const allianceMembers = new Map<string, Set<string>>();
  for (const a of alliances) {
    try {
      const list = JSON.parse(a.member_countries) as AllianceMember[];
      allianceMembers.set(a.name, new Set(list.map(m => m.country)));
    } catch {
      allianceMembers.set(a.name, new Set());
    }
  }

  const allMemberIds = new Set<string>();
  for (const members of allianceMembers.values()) {
    for (const id of members) allMemberIds.add(id);
  }

  const rounds = db.prepare(`
    SELECT b.id as battle_id, b.attacker_country, b.defender_country,
           DATE(b.created_at) as day,
           br.number, br.attacker_damages, br.defender_damages
    FROM battles b
    JOIN battle_rounds br ON br.battle_id = b.id
    WHERE DATE(b.created_at) >= ?
    ORDER BY b.created_at
  `).all(yesterday) as BattleRoundRow[];

  const countryNameMap = new Map<string, string>();
  if (allMemberIds.size > 0) {
    const ids = [...allMemberIds];
    const ph = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id, name FROM countries WHERE id IN (${ph})`).all(...ids) as { id: string; name: string }[];
    for (const r of rows) countryNameMap.set(r.id, r.name);
  }

  type DayData = { total: number; byCountry: Map<string, number> };
  const allianceData = new Map<string, { today: DayData; yesterday: DayData }>();

  for (const a of allianceMembers.keys()) {
    allianceData.set(a, {
      today: { total: 0, byCountry: new Map() },
      yesterday: { total: 0, byCountry: new Map() },
    });
  }

  for (const r of rounds) {
    const isToday = r.day === today;
    const isYesterday = r.day === yesterday;
    if (!isToday && !isYesterday) continue;

    for (const [aName, members] of allianceMembers) {
      const hitAttacker = members.has(r.attacker_country);
      const hitDefender = members.has(r.defender_country);

      if (!hitAttacker && !hitDefender) continue;

      const dayData = isToday
        ? allianceData.get(aName)!.today
        : allianceData.get(aName)!.yesterday;

      if (hitAttacker) {
        const dmg = r.attacker_damages ?? 0;
        dayData.total += dmg;
        const c = r.attacker_country;
        dayData.byCountry.set(c, (dayData.byCountry.get(c) ?? 0) + dmg);
      }
      if (hitDefender) {
        const dmg = r.defender_damages ?? 0;
        dayData.total += dmg;
        const c = r.defender_country;
        dayData.byCountry.set(c, (dayData.byCountry.get(c) ?? 0) + dmg);
      }
    }
  }

  const sorted = [...allianceData.entries()]
    .filter(([, d]) => d.today.total > 0)
    .sort((a, b) => b[1].today.total - a[1].today.total);

  console.log(`${'═'.repeat(60)}`);
  console.log(`  Täglicher Allianz-Schadensreport`);
  console.log(`  ${today}`);
  console.log(`${'═'.repeat(60)}`);

  if (sorted.length === 0) {
    console.log(`\n  Keine Allianz-Battles in den letzten 24h.\n`);
    return;
  }

  for (const [name, data] of sorted) {
    const members = allianceMembers.get(name)!;
    const todayTotal = data.today.total;
    const yesterdayTotal = data.yesterday.total;
    const memberCount = [...members].filter(id => data.today.byCountry.has(id)).length;

    let pctStr: string;
    if (yesterdayTotal > 0) {
      const pct = ((todayTotal - yesterdayTotal) / yesterdayTotal) * 100;
      const sign = pct >= 0 ? '+' : '';
      pctStr = `${sign}${pct.toFixed(1)}%`;
    } else {
      pctStr = '—';
    }

    console.log();
    console.log(`  ${name} (${memberCount}/${members.size} aktiv)`);
    console.log(`  ${'─'.repeat(56)}`);
    console.log(`    Gesamt: ${fmtDamage(todayTotal).padStart(10)}  (${pctStr})`);

    const sortedCountries = [...data.today.byCountry.entries()]
      .sort((a, b) => b[1] - a[1]);

    for (const [cId, dmg] of sortedCountries) {
      const cName = countryNameMap.get(cId) ?? cId.slice(0, 12);
      console.log(`    ${cName.padEnd(24)} ${fmtDamage(dmg).padStart(10)}`);
    }
  }

  console.log();
  console.log(`${'═'.repeat(60)}`);
  console.log(`  ${sorted.length} Allianzen mit Battles`);
  console.log();
}

main();
