import 'dotenv/config';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const dataDir = path.resolve(process.env.SCRAPER_DATA_DIR || path.join(ROOT, 'data'));
const dbPath = path.join(dataDir, 'warera.db');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

const ALLIANCE_NAME = 'B.E.E.R';

interface BattleRow {
  id: string;
  type: string;
  is_active: number;
  rounds_to_win: number;
  created_at: string;
  ended_at: string;
  won_by: string;
  attacker_country: string;
  defender_country: string;
  attacker_won_rounds: number;
  defender_won_rounds: number;
  attacker_money_pool: number;
  defender_money_pool: number;
}

interface ContractRow {
  id: string;
  for_country_side: string;
  current_payout: number;
  current_per_k: number;
  minimum_damage: number;
  current_winner: string;
  professionals_only: number;
  round_number: number;
}

function main() {
  const alliance = db.prepare('SELECT * FROM alliances WHERE name = ?').get(ALLIANCE_NAME) as Record<string, unknown> | undefined;
  if (!alliance) {
    console.error(`Alliance "${ALLIANCE_NAME}" not found in database.`);
    process.exit(1);
  }

  const memberCountriesRaw = alliance.member_countries as string | undefined;
  let rawList: { country: string }[];
  try {
    rawList = memberCountriesRaw ? JSON.parse(memberCountriesRaw) : [];
  } catch {
    rawList = [];
  }
  const memberCountries = rawList.map(r => r.country).filter(Boolean);

  if (memberCountries.length === 0) {
    console.error(`No member countries found for ${ALLIANCE_NAME}.`);
    process.exit(1);
  }

  const memberSet = new Set(memberCountries);
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const placeholders = memberCountries.map(() => '?').join(',');

  const battles = db.prepare(`
    SELECT * FROM battles
    WHERE created_at >= ?
      AND (attacker_country IN (${placeholders})
        OR defender_country IN (${placeholders}))
    ORDER BY created_at DESC
  `).all(cutoff, ...memberCountries, ...memberCountries) as BattleRow[];

  if (battles.length === 0) {
    console.log(`\n${ALLIANCE_NAME} – Keine Schlachten in den letzten 24h.\n`);
    return;
  }

  const allCountryIds = [...new Set(battles.flatMap(b => [b.attacker_country, b.defender_country]))];
  const countryPlaceholders = allCountryIds.map(() => '?').join(',');
  const countryNames = db.prepare(
    `SELECT id, name FROM countries WHERE id IN (${countryPlaceholders})`,
  ).all(...allCountryIds) as { id: string; name: string }[];
  const countryNameMap = new Map(countryNames.map(c => [c.id, c.name]));

  const out: string[] = [];
  const wl = (line = '') => { out.push(line); console.log(line); };

  wl(`╔═══════════════════════════════════════════════════════════════`);
  wl(`║  ${ALLIANCE_NAME} – Schlachten der letzten 24h`);
  wl(`║  ${new Date().toISOString().slice(0, 10)}`);
  wl(`╚═══════════════════════════════════════════════════════════════`);
  wl();

  let totalBattles = 0;
  let totalRounds = 0;
  let totalAttContracts = 0;
  let totalDefContracts = 0;
  let totalAttBounties = 0;
  let totalDefBounties = 0;

  for (const b of battles) {
    totalBattles++;
    const attName = countryNameMap.get(b.attacker_country) ?? b.attacker_country;
    const defName = countryNameMap.get(b.defender_country) ?? b.defender_country;
    const isBeerAttacker = memberSet.has(b.attacker_country);
    const isBeerDefender = memberSet.has(b.defender_country);
    const beerLabel = isBeerAttacker ? attName : defName;
    const oppLabel = isBeerAttacker ? defName : attName;
    const beerSide = isBeerAttacker ? 'attacker' : 'defender';
    const oppSide = isBeerAttacker ? 'defender' : 'attacker';

    const roundCount = (db.prepare(
      'SELECT COUNT(*) AS cnt FROM battle_rounds WHERE battle_id = ?',
    ).get(b.id) as { cnt: number }).cnt;
    totalRounds += roundCount;

    const contracts = db.prepare(`
      SELECT * FROM mercenary_contracts WHERE battle_id = ? AND for_country_side = ? ORDER BY round_number
    `).all(b.id, beerSide) as ContractRow[];
    const oppContracts = db.prepare(`
      SELECT * FROM mercenary_contracts WHERE battle_id = ? AND for_country_side = ? ORDER BY round_number
    `).all(b.id, oppSide) as ContractRow[];

    const beerContractSum = contracts.reduce((s, c) => s + c.current_payout, 0);
    const oppContractSum = oppContracts.reduce((s, c) => s + c.current_payout, 0);

    totalAttContracts += isBeerAttacker ? beerContractSum : oppContractSum;
    totalDefContracts += isBeerDefender ? beerContractSum : oppContractSum;

    const beerMoneyPool = isBeerAttacker ? (b.attacker_money_pool ?? 0) : (b.defender_money_pool ?? 0);
    const oppMoneyPool = isBeerAttacker ? (b.defender_money_pool ?? 0) : (b.attacker_money_pool ?? 0);
    const beerBounties = Math.max(0, beerMoneyPool - beerContractSum);
    const oppBounties = Math.max(0, oppMoneyPool - oppContractSum);

    totalAttBounties += isBeerAttacker ? beerBounties : oppBounties;
    totalDefBounties += isBeerDefender ? beerBounties : oppBounties;

    const wonBy = b.won_by;
    const beerWon = (isBeerAttacker && wonBy === 'attacker') || (isBeerDefender && wonBy === 'defender');
    const statusIcon = b.is_active ? '⚔️' : (beerWon ? '✅' : '❌');

    wl(`${'─'.repeat(55)}`);
    wl(`  ${statusIcon} ${b.id.slice(0, 12)}  | ${b.created_at.slice(0, 16)}`);
    wl(`  ${attName} vs ${defName}`);
    wl(`  Runden: ${roundCount}  (${b.attacker_won_rounds ?? '?'}:${b.defender_won_rounds ?? '?'})`);
    wl();

    if (contracts.length > 0 || oppContracts.length > 0) {
      const printContract = (list: ContractRow[], label: string) => {
        if (list.length === 0) return;
        wl(`  ${label} – Verträge:`);
        for (const c of list) {
          const prof = c.professionals_only ? ' [nur Profis]' : '';
          wl(`    ${(c.current_winner ?? '?').slice(0, 16).padEnd(16)} ${c.current_payout.toFixed(2).padStart(8)} btc  (${c.current_per_k.toFixed(2)}/1k, Runde ${c.round_number})${prof}`);
        }
      };
      printContract(contracts, `${beerLabel}`);
      printContract(oppContracts, `${oppLabel}`);
    }

    wl();
    wl(`  ${beerLabel}: ${(beerContractSum + beerBounties).toFixed(2).padStart(8)} btc gesamt  (Verträge: ${beerContractSum.toFixed(2)} / Bounties: ${beerBounties.toFixed(2)})`);
    wl(`  ${oppLabel}: ${(oppContractSum + oppBounties).toFixed(2).padStart(8)} btc gesamt  (Verträge: ${oppContractSum.toFixed(2)} / Bounties: ${oppBounties.toFixed(2)})`);
    wl();
  }

  wl();
  wl(`═${'═'.repeat(54)}`);
  wl(`  ${ALLIANCE_NAME} – Gesamtsumme (${totalBattles} Schlachten, ${totalRounds} Runden)`);
  wl(`═${'═'.repeat(54)}`);
  wl();
  wl(`  ${''.padEnd(20)} ${'Verträge'.padStart(10)} ${'Bounties'.padStart(10)} ${'Gesamt'.padStart(10)}`);
  wl(`  ${'─'.repeat(50)}`);
  wl(`  ${'Attacker'.padEnd(20)} ${totalAttContracts.toFixed(2).padStart(10)} ${totalAttBounties.toFixed(2).padStart(10)} ${(totalAttContracts + totalAttBounties).toFixed(2).padStart(10)}`);
  wl(`  ${'Defender'.padEnd(20)} ${totalDefContracts.toFixed(2).padStart(10)} ${totalDefBounties.toFixed(2).padStart(10)} ${(totalDefContracts + totalDefBounties).toFixed(2).padStart(10)}`);
  wl(`  ${'─'.repeat(50)}`);
  wl(`  ${'Gesamt'.padEnd(20)} ${(totalAttContracts + totalDefContracts).toFixed(2).padStart(10)} ${(totalAttBounties + totalDefBounties).toFixed(2).padStart(10)} ${(totalAttContracts + totalDefContracts + totalAttBounties + totalDefBounties).toFixed(2).padStart(10)}`);
  wl();

  const outDir = path.join(ROOT, 'reports');
  const outFile = path.join(outDir, `beer-battles-${new Date().toISOString().slice(0, 10)}.txt`);
  fs.writeFileSync(outFile, out.join('\n'), 'utf-8');
  console.log(`Report saved to ${outFile}`);
}

main();
