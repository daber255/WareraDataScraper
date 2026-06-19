import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const dataDir = path.resolve(process.env.SCRAPER_DATA_DIR || path.join(ROOT, 'data'));
const dbPath = path.join(dataDir, 'warera.db');
const alliancesPath = path.join(ROOT, 'config/alliances.json');
const outDir = path.join(ROOT, 'docs', 'data');

type Json = Record<string, unknown>;

interface AllianceConfig {
  name: string;
  color: string;
  members: string[];
}

interface WarUser {
  username: string;
  level: number;
  health: { current: number; max: number };
  hunger: { current: number; max: number };
  buff: number;
  debuff: number;
}

interface CountryData {
  country: string;
  normalUsers: WarUser[];
  buffUsers: WarUser[];
  normalCount: number;
  buffCount: number;
  debuffCount: number;
  totalUsers: number;
  avgHealthPct: number;
  avgHungerPct: number;
  avgBuffHealthPct: number;
  avgBuffHungerPct: number;
}

interface AllianceOutput {
  name: string;
  color: string;
  members: CountryData[];
  totalNormal: number;
  totalBuff: number;
  totalDebuff: number;
  totalUsers: number;
  avgHealthPct: number;
  avgHungerPct: number;
}

function loadAlliances(): AllianceConfig[] {
  return JSON.parse(fs.readFileSync(alliancesPath, 'utf-8')).alliances;
}

function classifySkills(user: { skill_attack_level: number; skill_health_level: number; skill_armor_level: number; skill_critical_chance_level: number; skill_critical_damages_level: number; skill_precision_level: number; skill_dodge_level: number; skill_loot_chance_level: number; skill_production_level: number; skill_companies_level: number; skill_entrepreneurship_level: number; skill_management_level: number }): boolean {
  const warScore =
    (user.skill_attack_level ?? 0) +
    (user.skill_health_level ?? 0) +
    (user.skill_armor_level ?? 0) +
    (user.skill_critical_chance_level ?? 0) +
    (user.skill_critical_damages_level ?? 0) +
    (user.skill_precision_level ?? 0) +
    (user.skill_dodge_level ?? 0) +
    (user.skill_loot_chance_level ?? 0);
  const ecoScore =
    (user.skill_production_level ?? 0) +
    (user.skill_companies_level ?? 0) +
    (user.skill_entrepreneurship_level ?? 0) +
    (user.skill_management_level ?? 0);
  const total = warScore + ecoScore;
  if (total === 0) return false;
  return warScore / total > 0.5;
}

function main() {
  const alliances = loadAlliances();
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  const nameToId = new Map(
    (db.prepare('SELECT id, name FROM countries').all() as { id: string; name: string }[]).map(r => [r.name, r.id]),
  );

  const normalByCountry = new Map<string, WarUser[]>();
  const buffByCountry = new Map<string, WarUser[]>();
  const debuffCountByCountry = new Map<string, number>();
  const totalByCountry = new Map<string, number>();

  const allUsers = db.prepare(`
    SELECT username, level, country,
      skill_attack_level, skill_health_level, skill_armor_level,
      skill_critical_chance_level, skill_critical_damages_level,
      skill_precision_level, skill_dodge_level, skill_loot_chance_level,
      skill_production_level, skill_companies_level,
      skill_entrepreneurship_level, skill_management_level,
      skill_health_data, skill_hunger_data,
      skill_attack_data
    FROM users
  `).all() as Array<{
    username: string; level: number; country: string;
    skill_attack_level: number; skill_health_level: number; skill_armor_level: number;
    skill_critical_chance_level: number; skill_critical_damages_level: number;
    skill_precision_level: number; skill_dodge_level: number; skill_loot_chance_level: number;
    skill_production_level: number; skill_companies_level: number;
    skill_entrepreneurship_level: number; skill_management_level: number;
    skill_health_data: string | null; skill_hunger_data: string | null;
    skill_attack_data: string | null;
  }>;

  for (const u of allUsers) {
    totalByCountry.set(u.country, (totalByCountry.get(u.country) ?? 0) + 1);
    if (!classifySkills(u)) continue;

    let health = { current: 0, max: 100 };
    let hunger = { current: 0, max: 5 };
    let buff = 0;
    let debuff = 0;

    if (u.skill_health_data) {
      try {
        const hd: Json = JSON.parse(u.skill_health_data);
        health = { current: Math.round((hd.currentBarValue as number) * 10) / 10, max: Math.round(hd.total as number) };
      } catch { /* fallback */ }
    }

    if (u.skill_hunger_data) {
      try {
        const hud: Json = JSON.parse(u.skill_hunger_data);
        hunger = { current: Math.round((hud.currentBarValue as number) * 10) / 10, max: Math.round(hud.total as number) };
      } catch { /* fallback */ }
    }

    if (u.skill_attack_data) {
      try {
        const ad: Json = JSON.parse(u.skill_attack_data);
        buff = (ad.buffsPercent as number) ?? 0;
        debuff = (ad.debuffsPercent as number) ?? 0;
      } catch { /* fallback */ }
    }

    const warUser: WarUser = { username: u.username, level: u.level, health, hunger, buff, debuff };

    if (buff > 0) {
      const arr = buffByCountry.get(u.country) ?? [];
      arr.push(warUser);
      buffByCountry.set(u.country, arr);
    } else if (debuff > 0) {
      debuffCountByCountry.set(u.country, (debuffCountByCountry.get(u.country) ?? 0) + 1);
    } else {
      const arr = normalByCountry.get(u.country) ?? [];
      arr.push(warUser);
      normalByCountry.set(u.country, arr);
    }
  }

  const output: { exportedAt: string; alliances: AllianceOutput[] } = {
    exportedAt: new Date().toISOString(),
    alliances: [],
  };

  for (const a of alliances) {
    const members: CountryData[] = [];
    let totalNormal = 0;
    let totalBuff = 0;
    let totalDebuff = 0;
    let totalUsers = 0;
    let sumHealthPct = 0;
    let sumHungerPct = 0;
    let sumBuffHealthPct = 0;
    let sumBuffHungerPct = 0;
    let normalCount = 0;
    let buffCount = 0;

    for (const memberName of a.members) {
      const cid = nameToId.get(memberName);
      if (!cid) continue;

      const normalUsers = normalByCountry.get(cid) ?? [];
      const buffUsers = buffByCountry.get(cid) ?? [];
      const total = totalByCountry.get(cid) ?? 0;
      const debuffCount = debuffCountByCountry.get(cid) ?? 0;

      totalNormal += normalUsers.length;
      totalBuff += buffUsers.length;
      totalDebuff += debuffCount;
      totalUsers += total;

      const avgHP = normalUsers.length > 0
        ? normalUsers.reduce((s, u) => s + (u.health.max > 0 ? (u.health.current / u.health.max) * 100 : 0), 0) / normalUsers.length
        : 0;
      const avgHunger = normalUsers.length > 0
        ? normalUsers.reduce((s, u) => s + (u.hunger.max > 0 ? (u.hunger.current / u.hunger.max) * 100 : 0), 0) / normalUsers.length
        : 0;
      const avgBuffHP = buffUsers.length > 0
        ? buffUsers.reduce((s, u) => s + (u.health.max > 0 ? (u.health.current / u.health.max) * 100 : 0), 0) / buffUsers.length
        : 0;
      const avgBuffHunger = buffUsers.length > 0
        ? buffUsers.reduce((s, u) => s + (u.hunger.max > 0 ? (u.hunger.current / u.hunger.max) * 100 : 0), 0) / buffUsers.length
        : 0;

      members.push({
        country: memberName,
        normalUsers,
        buffUsers,
        normalCount: normalUsers.length,
        buffCount: buffUsers.length,
        debuffCount,
        totalUsers: total,
        avgHealthPct: Math.round(avgHP * 10) / 10,
        avgHungerPct: Math.round(avgHunger * 10) / 10,
        avgBuffHealthPct: Math.round(avgBuffHP * 10) / 10,
        avgBuffHungerPct: Math.round(avgBuffHunger * 10) / 10,
      });

      sumHealthPct += avgHP * normalUsers.length;
      sumHungerPct += avgHunger * normalUsers.length;
      normalCount += normalUsers.length;
      sumBuffHealthPct += avgBuffHP * buffUsers.length;
      sumBuffHungerPct += avgBuffHunger * buffUsers.length;
      buffCount += buffUsers.length;
    }

    const filteredMembers = members.filter(m => m.normalCount + m.buffCount > 0);

    output.alliances.push({
      name: a.name,
      color: a.color,
      members: filteredMembers.sort((a, b) => (b.normalCount + b.buffCount) - (a.normalCount + a.buffCount)),
      totalNormal,
      totalBuff,
      totalDebuff,
      totalUsers,
      avgHealthPct: normalCount > 0 ? Math.round((sumHealthPct / normalCount) * 10) / 10 : 0,
      avgHungerPct: normalCount > 0 ? Math.round((sumHungerPct / normalCount) * 10) / 10 : 0,
    });
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'alliances.json'), JSON.stringify(output, null, 2), 'utf-8');
  console.log(`Exported ${output.alliances.length} alliances to ${outDir}/alliances.json`);

  for (const a of output.alliances) {
    console.log(`  ${a.name}: ${a.totalNormal} normal + ${a.totalBuff} buffed + ${a.totalDebuff} debuffed = ${a.totalNormal + a.totalBuff + a.totalDebuff} war users`);
  }

  db.close();
}

main();
