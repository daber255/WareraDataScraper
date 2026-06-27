import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(__dirname, '..');
const dataDir = path.resolve(process.env.SCRAPER_DATA_DIR || path.join(ROOT, 'data'));
const dbPath = path.join(dataDir, 'warera.db');

const db = new Database(dbPath, { readonly: true });

function fmtBtc(v: number): string {
  return v.toFixed(3) + ' BTC';
}

function ppFromLevel(lv: number): number {
  return 10 + lv * 3;
}

function epFromLevel(lv: number): number {
  return 30 + lv * 10;
}

function ppPerDay(prodLv: number, energyLv: number): number {
  const pp = ppFromLevel(prodLv);
  const ep = epFromLevel(energyLv);
  const cycles = ep * 0.24;
  return cycles * pp;
}

function totalPpPerDay(prodLv: number, energyLv: number, totalBonus: number): number {
  return ppPerDay(prodLv, energyLv) * (1 + totalBonus / 100);
}

interface WorkerRow {
  user_id: string;
  username: string;
  prod_lv: number;
  energy_lv: number;
  wage: number;
  total_bonus: number;
  company_country_id: string;
  company_country_name: string;
  tax_income: number;
  joined_at: string;
  home_country_id: string;
  home_country_name: string;
}

interface WorkerSummary {
  username: string;
  prodLv: number;
  energyLv: number;
  pp: number;
  ep: number;
  totalPpD: number;
  wageD: number;
  taxD: number;
  toHomeD: number;
  toHomeW: number;
  companyCountry: string;
  taxPct: number;
  joinedAt: string;
  items: { company: string; bonus: number }[];
}

function main() {
  const targetCountryId = process.argv[2] || null;
  const targetWhere = targetCountryId
    ? `AND cu.id = '${targetCountryId.replace(/'/g, "''")}'`
    : '';

  const rows = db.prepare(`
    SELECT
      u.id              AS user_id,
      COALESCE(u.username, '?') AS username,
      COALESCE(u.skill_production_level, 0) AS prod_lv,
      COALESCE(u.skill_energy_level, 0) AS energy_lv,
      COALESCE(cw.wage, 0) AS wage,
      COALESCE(cp.total_bonus, 0) AS total_bonus,
      cc.id             AS company_country_id,
      cc.name           AS company_country_name,
      COALESCE(cc.tax_income, 0) AS tax_income,
      COALESCE(cw.joined_at, '') AS joined_at,
      cu.id             AS home_country_id,
      cu.name           AS home_country_name
    FROM company_workers cw
    JOIN companies cp ON cp.id = cw.company_id
    JOIN regions r ON r.id = cp.region
    JOIN countries cc ON cc.id = r.country_id
    JOIN users u ON u.id = cw.user_id
    JOIN countries cu ON cu.id = u.country
    WHERE cw.wage > 0
    ${targetWhere}
    ORDER BY cu.name, u.username
  `).all() as WorkerRow[];

  const out: string[] = [];

  if (rows.length === 0) {
    out.push('No workers found.');
    console.log(out[0]);
    db.close();
    return;
  }

  const homeName = rows[0].home_country_name;
  const safeName = homeName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const dateStr = new Date().toISOString().slice(0, 10);

  out.push(`=== Production Tax Report — ${homeName} ===`);
  out.push(`(Level 20+, weekly projection)`);
  out.push('');

  const byUser = new Map<string, WorkerSummary>();

  for (const r of rows) {
    const pp = ppFromLevel(r.prod_lv);
    const ep = epFromLevel(r.energy_lv);
    const tppd = totalPpPerDay(r.prod_lv, r.energy_lv, r.total_bonus);
    const wageD = tppd * r.wage;
    const taxD = wageD * r.tax_income / 100;
    const toHomeD = taxD * 0.30;
    const toHomeW = toHomeD * 7;

    const existing = byUser.get(r.user_id);
    if (existing) {
      existing.items.push({ company: r.company_country_name, bonus: r.total_bonus });
      if (r.joined_at > existing.joinedAt) {
        existing.totalPpD = tppd;
        existing.wageD = wageD;
        existing.taxD = taxD;
        existing.toHomeD = toHomeD;
        existing.toHomeW = toHomeW;
        existing.companyCountry = r.company_country_name;
        existing.taxPct = r.tax_income;
        existing.joinedAt = r.joined_at;
      }
    } else {
      byUser.set(r.user_id, {
        username: r.username,
        prodLv: r.prod_lv,
        energyLv: r.energy_lv,
        pp,
        ep,
        totalPpD: tppd,
        wageD,
        taxD,
        toHomeD,
        toHomeW,
        companyCountry: r.company_country_name,
        taxPct: r.tax_income,
        joinedAt: r.joined_at,
        items: [{ company: r.company_country_name, bonus: r.total_bonus }],
      });
    }
  }

  const multiJobUsers = [...byUser.values()].filter(s => s.items.length > 1);
  if (multiJobUsers.length > 0) {
    out.push(`Note: ${multiJobUsers.length} user(s) have multiple job entries — using most recent job only.`);
    out.push('');
  }

  const sorted = [...byUser.values()].sort((a, b) => b.toHomeW - a.toHomeW);

  const header = `${'Worker'.padEnd(24)} ${'PP'.padStart(4)} ${'EP'.padStart(4)} ${'TotalPP/d'.padStart(9)} ${'Wage/d'.padStart(14)} ${'Tax/d'.padStart(14)} ${'→Home/d'.padStart(14)} ${'→Home/w'.padStart(14)}  Firmenland`;
  const sep = `${''.padStart(24, '─')} ${''.padStart(4, '─')} ${''.padStart(4, '─')} ${''.padStart(9, '─')} ${''.padStart(14, '─')} ${''.padStart(14, '─')} ${''.padStart(14, '─')} ${''.padStart(14, '─')}  ${''.padStart(20, '─')}`;

  out.push(header);
  out.push(sep);

  for (const s of sorted) {
    out.push(
      `${s.username.padEnd(24)} ${String(s.pp).padStart(4)} ${String(s.ep).padStart(4)} ${
        s.totalPpD.toFixed(1).padStart(9)} ${fmtBtc(s.wageD).padStart(14)} ${fmtBtc(s.taxD).padStart(14)} ${
        fmtBtc(s.toHomeD).padStart(14)} ${fmtBtc(s.toHomeW).padStart(14)}  ${s.companyCountry} (${s.taxPct}%)`
    );
  }

  out.push(sep);

  const totals = sorted.reduce(
    (s, w) => ({
      workers: s.workers + 1,
      wageD: s.wageD + w.wageD,
      taxD: s.taxD + w.taxD,
      toHomeD: s.toHomeD + w.toHomeD,
      toHomeW: s.toHomeW + w.toHomeW,
    }),
    { workers: 0, wageD: 0, taxD: 0, toHomeD: 0, toHomeW: 0 },
  );

  out.push('');
  out.push(`─── Totals (${totals.workers} workers) ───`);
  out.push(`${''.padStart(14)} ${'Daily'.padStart(14)} ${'Weekly'.padStart(14)}`);
  out.push(`${'Total Wage:'.padEnd(14)} ${fmtBtc(totals.wageD).padStart(14)} ${fmtBtc(totals.wageD * 7).padStart(14)}`);
  out.push(`${'Total Tax:'.padEnd(14)} ${fmtBtc(totals.taxD).padStart(14)} ${fmtBtc(totals.taxD * 7).padStart(14)}`);
  out.push(`${'→ Home (30%):'.padEnd(14)} ${fmtBtc(totals.toHomeD).padStart(14)} ${fmtBtc(totals.toHomeW).padStart(14)}`);
  out.push(`${'→ Company (70%):'.padEnd(14)} ${fmtBtc(totals.taxD - totals.toHomeD).padStart(14)} ${fmtBtc((totals.taxD - totals.toHomeD) * 7).padStart(14)}`);

  const outDir = path.resolve(ROOT, 'reports');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `production-tax-${safeName}-${dateStr}.txt`);
  fs.writeFileSync(outFile, out.join('\n'), 'utf-8');

  console.log(out.join('\n'));
  console.log(`\nReport saved to ${outFile}`);

  db.close();
}

main();
