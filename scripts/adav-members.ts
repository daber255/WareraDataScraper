import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const dataDir = path.resolve(process.env.SCRAPER_DATA_DIR || path.join(ROOT, 'data'));
const dbPath = path.join(dataDir, 'warera.db');

interface MemberRow {
  user_id: string;
  username: string | null;
}

function main() {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  const rows = db
    .prepare(
      `SELECT m.value AS user_id, u.username
       FROM parties p
       CROSS JOIN json_each(p.members) AS m
       LEFT JOIN users u ON u.id = m.value
       WHERE p.name LIKE '%ADAV%'
       ORDER BY u.username IS NULL, u.username ASC`,
    )
    .all() as MemberRow[];

  const totalWithName = rows.filter(r => r.username !== null).length;
  const totalWithoutName = rows.filter(r => r.username === null).length;

  const groups = [
    { name: 'Schnabeltier', members: rows.slice(0, 47) },
    { name: 'Julibean', members: rows.slice(47, 94) },
    { name: 'Lowrenz', members: rows.slice(94) },
  ];

  console.log(`── ADAV Mitglieder (${rows.length} total, ${totalWithName} mit Username, ${totalWithoutName} ohne Username) ──\n`);

  for (const group of groups) {
    console.log(`══ Gruppe: ${group.name} (${group.members.length} Mitglieder) ══`);
    console.log(`  ${'User-ID'.padEnd(28)} Username`);
    console.log(`  ${''.padStart(28, '─')} ${''.padStart(20, '─')}`);
    for (const m of group.members) {
      const name = m.username ?? '(kein Username)';
      console.log(`  ${m.user_id.padEnd(28)} ${name}`);
    }
    console.log();
  }

  db.close();
}

main();
