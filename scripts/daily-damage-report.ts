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
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(Math.round(n));
}

function main() {
  const alliances = db.prepare('SELECT name, member_countries FROM alliances').all() as {
    name: string;
    member_countries: string;
  }[];

  const allianceMembers = new Map<string, Set<string>>();
  for (const a of alliances) {
    try {
      const list = JSON.parse(a.member_countries) as { country: string }[];
      allianceMembers.set(a.name, new Set(list.map(m => m.country)));
    } catch {
      // skip malformed
    }
  }

  const countryToAlliance = new Map<string, string>();
  for (const [name, members] of allianceMembers) {
    for (const id of members) {
      if (!countryToAlliance.has(id)) {
        countryToAlliance.set(id, name);
      }
    }
  }

  const rows = db.prepare('SELECT country, weekly_damages FROM users WHERE weekly_damages > 0').all() as {
    country: string;
    weekly_damages: number;
  }[];

  const countryIds = [...new Set(rows.map(r => r.country))];
  const countryNames = new Map<string, string>();
  if (countryIds.length > 0) {
    const ph = countryIds.map(() => '?').join(',');
    const names = db.prepare(`SELECT id, name FROM countries WHERE id IN (${ph})`).all(...countryIds) as {
      id: string;
      name: string;
    }[];
    for (const n of names) countryNames.set(n.id, n.name);
  }

  const damagePerCountry = new Map<string, number>();
  for (const r of rows) {
    damagePerCountry.set(r.country, (damagePerCountry.get(r.country) ?? 0) + r.weekly_damages);
  }

  const userDamage: { country_id: string; country_name: string; total_damage: number }[] = [];
  for (const [id, total_damage] of damagePerCountry) {
    userDamage.push({
      country_id: id,
      country_name: countryNames.get(id) ?? id.slice(0, 12),
      total_damage,
    });
  }
  userDamage.sort((a, b) => b.total_damage - a.total_damage);

  if (userDamage.length === 0) {
    console.log('Keine User-Schadensdaten gefunden.');
    return;
  }

  const allianceData = new Map<string, { total: number; countries: { name: string; damage: number }[] }>();
  const nonAlliance: { name: string; damage: number }[] = [];

  for (const row of userDamage) {
    const alliance = countryToAlliance.get(row.country_id);
    const entry = { name: row.country_name, damage: row.total_damage };

    if (alliance) {
      if (!allianceData.has(alliance)) {
        allianceData.set(alliance, { total: 0, countries: [] });
      }
      const data = allianceData.get(alliance)!;
      data.total += row.total_damage;
      data.countries.push(entry);
    } else {
      nonAlliance.push(entry);
    }
  }

  const sortedAlliances = [...allianceData.entries()]
    .sort((a, b) => b[1].total - a[1].total);

  nonAlliance.sort((a, b) => b.damage - a.damage);

  const today = new Date().toISOString().slice(0, 10);

  console.log(`${'═'.repeat(60)}`);
  console.log(`  Täglicher User-Schadensreport (weekly_damages)`);
  console.log(`  ${today}`);
  console.log(`${'═'.repeat(60)}`);

  for (const [name, data] of sortedAlliances) {
    const members = allianceMembers.get(name)!;
    const activeCount = data.countries.length;

    console.log();
    console.log(`  ${name} (${activeCount}/${members.size} aktiv)`);
    console.log(`  ${'─'.repeat(56)}`);
    console.log(`    Gesamt: ${fmtDamage(data.total).padStart(10)}`);

    for (const c of data.countries) {
      console.log(`    ${c.name.padEnd(24)} ${fmtDamage(c.damage).padStart(10)}`);
    }
  }

  if (nonAlliance.length > 0) {
    console.log();
    console.log(`  Ohne Allianz (${nonAlliance.length} Länder)`);
    console.log(`  ${'─'.repeat(56)}`);
    const total = nonAlliance.reduce((s, c) => s + c.damage, 0);
    console.log(`    Gesamt: ${fmtDamage(total).padStart(10)}`);

    for (const c of nonAlliance.slice(0, 10)) {
      console.log(`    ${c.name.padEnd(24)} ${fmtDamage(c.damage).padStart(10)}`);
    }
    if (nonAlliance.length > 10) {
      console.log(`    ... und ${nonAlliance.length - 10} weitere`);
    }
  }

  const totalUserDamage = userDamage.reduce((s, r) => s + r.total_damage, 0);
  console.log();
  console.log(`${'═'.repeat(60)}`);
  console.log(`  ${sortedAlliances.length + (nonAlliance.length > 0 ? 1 : 0)} Blöcke • ${fmtDamage(totalUserDamage)} gesamt`);
  console.log();
}

main();
