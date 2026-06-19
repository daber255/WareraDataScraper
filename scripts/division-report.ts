import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const dataDir = path.resolve(process.env.SCRAPER_DATA_DIR || path.join(ROOT, 'data'));
const reportsDir = path.join(ROOT, 'reports');
const dbPath = path.join(dataDir, 'warera.db');
const configPath = path.join(ROOT, 'config/divisions.json');

interface Division {
  name: string;
  mu_names: string[];
}

interface DivisionConfig {
  version: number;
  divisions: Division[];
}

interface MuRow {
  id: string;
  name: string;
  members: string;
  member_count: number;
  weekly_damages: number;
  wealth: number;
}

interface UserRow {
  id: string;
  username: string | null;
  weekly_damages: number;
  wealth: number;
  wealth_companies: number;
  wealth_items: number;
  wealth_money: number;
  wealth_equipments: number;
  wealth_weapons: number;
}

interface MuSummary {
  name: string;
  memberCount: number;
  unknownCount: number;
  knownCount: number;
  weeklyDmg: number;
  equip: number;
  avgEquip: number;
  weapons: number;
  avgWeapons: number;
  members: UserRow[];
  unknownIds: string[];
}

interface DivSummary {
  name: string;
  muSummaries: MuSummary[];
  userCount: number;
  weeklyDmg: number;
  equip: number;
  avgEquip: number;
  weapons: number;
  avgWeapons: number;
  memberCount: number;
}

const doubleLine = '═'.repeat(114);

const lines: string[] = [];

function log(msg = '') {
  console.log(msg);
  lines.push(msg);
}

function loadConfig(): DivisionConfig {
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

function fmtInt(v: number): string {
  return v.toLocaleString('de-DE');
}

function fmtBtc(v: number): string {
  return `${v.toFixed(3)} BTC`.padStart(14);
}

function padRight(s: string, n: number): string {
  return s.slice(0, n).padEnd(n);
}

function main() {
  const divConfig = loadConfig();
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  const targetDiv = process.argv[2]?.trim();
  const divisions = targetDiv
    ? divConfig.divisions.filter(d => d.name.toLowerCase() === targetDiv.toLowerCase())
    : divConfig.divisions;

  if (divisions.length === 0) {
    log(targetDiv
      ? `Division "${targetDiv}" nicht in config/divisions.json gefunden.`
      : 'Keine Divisionen in config/divisions.json definiert.');
    db.close();
    return;
  }

  const allMuNames = divisions.flatMap(d => d.mu_names);
  const muRows = db
    .prepare(
      `SELECT id, name, members, member_count,
              weekly_damages, wealth
       FROM military_units
       WHERE name IN (${allMuNames.map(() => '?').join(',')})`,
    )
    .all(...allMuNames) as MuRow[];

  const muByName = new Map<string, MuRow>();
  for (const mu of muRows) {
    muByName.set(mu.name, mu);
  }

  const missingNames = allMuNames.filter(n => !muByName.has(n));
  if (missingNames.length > 0) {
    log(`Nicht gefundene MUs: ${missingNames.join(', ')}`);
    log();
  }

  const divSummaries: DivSummary[] = [];
  let grandTotalUsers = 0;
  let grandTotalWeeklyDmg = 0;
  let grandTotalEquip = 0;
  let grandTotalWeapons = 0;
  let grandTotalMembers = 0;

  for (const div of divisions) {
    const divMus = div.mu_names
      .map(n => muByName.get(n))
      .filter((m): m is MuRow => m !== undefined);

    if (divMus.length === 0) {
      log(`══ Division: ${div.name} (keine MUs gefunden) ══\n`);
      continue;
    }

    const allUserIds = new Set<string>();
    for (const mu of divMus) {
      const ids: string[] = JSON.parse(mu.members);
      for (const id of ids) {
        allUserIds.add(id);
      }
    }

    const userIdsArr = [...allUserIds];
    const userRows = userIdsArr.length > 0
      ? db
          .prepare(
            `SELECT id, username, weekly_damages, wealth,
                    wealth_companies, wealth_items, wealth_money,
                    wealth_equipments, wealth_weapons
             FROM users WHERE id IN (${userIdsArr.map(() => '?').join(',')})`,
          )
          .all(...userIdsArr) as UserRow[]
      : [];

    const userById = new Map<string, UserRow>();
    for (const u of userRows) {
      userById.set(u.id, u);
    }

    const muSummaries: MuSummary[] = [];
    let divTotalWeeklyDmg = 0;
    let divTotalEquip = 0;
    let divTotalWeapons = 0;
    let divTotalMembers = 0;

    for (const mu of divMus) {
      const memberIds: string[] = JSON.parse(mu.members);

      const memberUsers = memberIds
        .map(id => userById.get(id))
        .filter((u): u is UserRow => u !== undefined)
        .sort((a, b) => b.weekly_damages - a.weekly_damages);

      const muWeeklyDmg = memberUsers.reduce((s, u) => s + u.weekly_damages, 0);
      const muEquip = memberUsers.reduce((s, u) => s + u.wealth_equipments, 0);
      const muWeapons = memberUsers.reduce((s, u) => s + u.wealth_weapons, 0);
      const muKnownCount = memberUsers.length;
      const muAvgEquip = muKnownCount > 0 ? muEquip / muKnownCount : 0;
      const muAvgWeapons = muKnownCount > 0 ? muWeapons / muKnownCount : 0;

      divTotalWeeklyDmg += muWeeklyDmg;
      divTotalEquip += muEquip;
      divTotalWeapons += muWeapons;
      divTotalMembers += muKnownCount;

      const unknownIds = memberIds.filter(id => !userById.has(id));

      muSummaries.push({
        name: mu.name,
        memberCount: memberIds.length,
        unknownCount: unknownIds.length,
        knownCount: muKnownCount,
        weeklyDmg: muWeeklyDmg,
        equip: muEquip,
        avgEquip: muAvgEquip,
        weapons: muWeapons,
        avgWeapons: muAvgWeapons,
        members: memberUsers,
        unknownIds,
      });
    }

    const divAvgEquip = divTotalMembers > 0 ? divTotalEquip / divTotalMembers : 0;
    const divAvgWeapons = divTotalMembers > 0 ? divTotalWeapons / divTotalMembers : 0;

    divSummaries.push({
      name: div.name,
      muSummaries,
      userCount: userIdsArr.length,
      weeklyDmg: divTotalWeeklyDmg,
      equip: divTotalEquip,
      avgEquip: divAvgEquip,
      weapons: divTotalWeapons,
      avgWeapons: divAvgWeapons,
      memberCount: divTotalMembers,
    });

    grandTotalUsers += userIdsArr.length;
    grandTotalWeeklyDmg += divTotalWeeklyDmg;
    grandTotalEquip += divTotalEquip;
    grandTotalWeapons += divTotalWeapons;
    grandTotalMembers += divTotalMembers;
  }

  // ═══════════════════════════════════════════════
  // PASS 1: Aggregate summaries (top)
  // ═══════════════════════════════════════════════

  for (const div of divSummaries) {
    log(`══ Division: ${div.name} (${div.muSummaries.length} MUs, ${div.userCount} User) ══`);
    log(`  Schaden  │  Ausrüstung (gesamt / Ø)  │  Waffen (gesamt / Ø)`);
    log();

    for (const mu of div.muSummaries) {
      log(`  Σ MU ${padRight(mu.name, 24)} ${fmtInt(mu.weeklyDmg).padStart(12)}  │  ${fmtBtc(mu.equip)} ${fmtBtc(mu.avgEquip)}  │  ${fmtBtc(mu.weapons)} ${fmtBtc(mu.avgWeapons)}`);
    }

    log(`  ${doubleLine}`);
    log(`  Σ DIV ${padRight(div.name, 24)} ${fmtInt(div.weeklyDmg).padStart(12)}  │  ${fmtBtc(div.equip)} ${fmtBtc(div.avgEquip)}  │  ${fmtBtc(div.weapons)} ${fmtBtc(div.avgWeapons)}`);
    log();
  }

  if (divSummaries.length > 1) {
    const grandAvgEquip = grandTotalMembers > 0 ? grandTotalEquip / grandTotalMembers : 0;
    const grandAvgWeapons = grandTotalMembers > 0 ? grandTotalWeapons / grandTotalMembers : 0;
    log(`  ${doubleLine}`);
    log(`  Σ ALLE ${padRight('Divisionen', 24)} ${fmtInt(grandTotalWeeklyDmg).padStart(12)}  │  ${fmtBtc(grandTotalEquip)} ${fmtBtc(grandAvgEquip)}  │  ${fmtBtc(grandTotalWeapons)} ${fmtBtc(grandAvgWeapons)}`);
    log();
  }

  // ═══════════════════════════════════════════════
  // PASS 2: Member details (bottom)
  // ═══════════════════════════════════════════════

  for (const div of divSummaries) {
    for (const mu of div.muSummaries) {
      log(`══ Mitglieder: ${mu.name} (${mu.memberCount}, davon ${mu.unknownCount} unbekannt) ══`);
      log();

      if (mu.members.length > 0) {
        log(`  ${'Rang'.padEnd(5)} ${'Username'.padEnd(22)} ${'Weekly Dmg'.padStart(12)} ${'Equip'.padStart(14)} ${'Weapons'.padStart(14)}`);
        log(`  ${''.padStart(5, '─')} ${''.padStart(22, '─')} ${''.padStart(12, '─')} ${''.padStart(14, '─')} ${''.padStart(14, '─')}`);
        for (let i = 0; i < mu.members.length; i++) {
          const u = mu.members[i];
          const uname = u.username ?? '(unbekannt)';
          log(
            `  ${String(i + 1).padEnd(5)}` +
            `${padRight(uname, 22)}` +
            `${fmtInt(u.weekly_damages).padStart(12)}` +
            `${fmtBtc(u.wealth_equipments)}` +
            `${fmtBtc(u.wealth_weapons)}`,
          );
        }
        log();
      }

      if (mu.unknownCount > 0) {
        log(`  Unbekannte User (${mu.unknownCount}):`);
        log(`  ${'Rang'.padEnd(5)} ${'User-ID'.padEnd(28)}`);
        log(`  ${''.padStart(5, '─')} ${''.padStart(28, '─')}`);
        for (let i = 0; i < mu.unknownIds.length; i++) {
          log(`  ${String(i + 1).padEnd(5)} ${mu.unknownIds[i].padEnd(28)}`);
        }
        log();
      }
    }
  }

  db.close();

  // ═══════════════════════════════════════════════
  // Legend & file output
  // ═══════════════════════════════════════════════

  log();
  log(`Legende:`);
  log(`  Weekly Dmg       – Summe der wöchentlichen Schäden aller Mitglieder`);
  log(`  Equip / Ø Equip – Gesamtwert / Schnitt Ausrüstung (BTC)`);
  log(`  Weapons / Ø Weapons – Gesamtwert / Schnitt Waffen (BTC)`);
  log();

  fs.mkdirSync(reportsDir, { recursive: true });
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const divLabel = targetDiv ? targetDiv.replace(/\s+/g, '_') : 'alle';
  const outPath = path.join(reportsDir, `divisions-report-${divLabel}-${ts}.txt`);
  fs.writeFileSync(outPath, lines.join('\n'), 'utf-8');
  log(`Report gespeichert: ${outPath}`);
}

main();
