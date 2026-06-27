import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import {
  db,
  loadAlliances,
  loadTopBattles,
  loadAllHistory,
  sumDamage,
  sumWealthDelta,
  fmtDmg,
  fmtBtcShort,
  fmtBtcAbbr,
  AllianceInfo,
  BattleSummary,
  AllianceHistory,
  AllianceData,
  WealthEntry,
  DamageEntry,
  BuildEntry,
  dominantDate,
  loadEquipmentUsage,
  type EquipmentCount,
} from './beer-war-pptx.js';

const W = 1200;
const PAD = 40;
const CW = W - PAD * 2;
const BEER_BLUE = '#2563eb';
const BEER_BG = '#eef2ff';
const BEER_DARK = '#1e3a5f';
const ENEMY_RED = '#dc2626';
const ENEMY_BG = '#fef2f2';
const WHITE = '#ffffff';
const DARK = '#1f2937';
const MID = '#6b7280';
const BORDER = '#e5e7eb';
const STUFE_COLORS = ['#25313a', '#0c341b', '#0a2255', '#2b1848', '#3e3908', '#490b0c'];

const ICON_DIR = path.resolve(__dirname, '..', 'docs', 'PicturesAusrüstung');
const iconCache = new Map<string, string>();
function iconDataUri(name: string): string {
  if (!iconCache.has(name)) {
    const buf = fs.readFileSync(path.join(ICON_DIR, name));
    iconCache.set(name, `data:image/png;base64,${buf.toString('base64')}`);
  }
  return iconCache.get(name)!;
}

function esc(s: unknown): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function cell(x: number, y: number, w: number, h: number, text: string, opts?: {
  align?: string; bold?: boolean; color?: string; size?: number;
}): string {
  const a = opts?.align ?? 'center';
  const anchor = a === 'left' ? 'start' : a === 'right' ? 'end' : 'middle';
  const tx = a === 'left' ? x + 8 : a === 'right' ? x + w - 8 : x + w / 2;
  const ty = y + h / 2 + 1;
  const parts: string[] = [];
  parts.push(`<text x="${tx}" y="${ty}" font-family="Arial,sans-serif" font-size="${opts?.size ?? 13}"`);
  parts.push(` fill="${opts?.color ?? DARK}" text-anchor="${anchor}" dominant-baseline="middle"`);
  if (opts?.bold) parts.push(' font-weight="bold"');
  parts.push(`>${esc(text)}</text>`);
  return parts.join('');
}

function rect(x: number, y: number, w: number, h: number, fill: string, radius = 0): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${radius ? ` rx="${radius}"` : ''}/>`;
}

function line(x1: number, y1: number, x2: number, y2: number, color: string, sw = 1): string {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${sw}"/>`;
}

interface ColDef {
  label: string;
  w: number;
  align?: string;
}

function drawTable(y: number, cols: ColDef[], rows: string[][],
  headerColor: string, altColor: string, rowH = 32): string {
  let svg = '';
  const hdrH = 30;

  svg += rect(PAD, y, CW, hdrH, headerColor, 4);
  let cx = PAD;
  for (const c of cols) {
    svg += cell(cx, y, c.w, hdrH, c.label, { color: WHITE, bold: true, size: 11, align: c.align ?? 'center' });
    cx += c.w;
  }

  for (let i = 0; i < rows.length; i++) {
    const ry = y + hdrH + i * rowH;
    const bg = i % 2 === 1 ? altColor : WHITE;
    svg += rect(PAD, ry, CW, rowH, bg);
    let rx = PAD;
    for (let j = 0; j < cols.length; j++) {
      const val = rows[i][j] ?? '';
      svg += cell(rx, ry, cols[j].w, rowH, val, { size: 11, align: cols[j].align ?? 'center' });
      rx += cols[j].w;
    }
    if (i < rows.length - 1) {
      svg += line(PAD, ry + rowH, PAD + CW, ry + rowH, BORDER, 0.5);
    }
  }

  return svg;
}

function drawStatsTable(y: number, cols: ColDef[], rows: string[][],
  headerColor: string, altColor: string, rowH = 28): string {
  let svg = '';
  const hdrH = 28;

  svg += rect(PAD, y, CW, hdrH, headerColor, 4);
  let cx = PAD;
  for (const c of cols) {
    svg += cell(cx, y, c.w, hdrH, c.label, { color: WHITE, bold: true, size: 10, align: c.align ?? 'center' });
    cx += c.w;
  }

  for (let i = 0; i < rows.length; i++) {
    const ry = y + hdrH + i * rowH;
    const isTotal = i === rows.length - 1;
    const bg = isTotal ? BORDER : (i % 2 === 1 ? altColor : WHITE);
    svg += rect(PAD, ry, CW, rowH, bg);
    let rx = PAD;
    for (let j = 0; j < cols.length; j++) {
      const val = rows[i][j] ?? '';
      svg += cell(rx, ry, cols[j].w, rowH, val, {
        size: 10, align: cols[j].align ?? 'center', bold: isTotal,
      });
      rx += cols[j].w;
    }
    if (!isTotal) {
      svg += line(PAD, ry + rowH, PAD + CW, ry + rowH, BORDER, 0.5);
    }
  }

  return svg;
}

function fmtBuild(n: number, prev: number): string {
  const d = n - prev;
  if (d > 0) return `${n} (+${d})`;
  if (d < 0) return `${n} (${d})`;
  return `${n}`;
}

function fmtBuildPct(war: number, eco: number): string {
  const total = war + eco;
  if (total === 0) return '\u2014';
  return `${Math.round(war / total * 100)}% / ${Math.round(eco / total * 100)}%`;
}

function buildStatsRows(data: AllianceData, needBold = false): string[][] {
  const rows: string[][] = [];
  for (const w of data.wealth) {
    const d = data.damage.find(x => x.country === w.country);
    const bc = data.buildCounts.get(w.country) ?? { war: 0, eco: 0 };
    const bp = data.buildCountsPrev.get(w.country) ?? { war: 0, eco: 0 };
    const deltaStr = (w.delta >= 0 ? '+' : '') + fmtBtcAbbr(w.delta);
    rows.push([
      w.country,
      String(w.members),
      fmtBtcAbbr(w.after),
      fmtBtcAbbr(w.warAfter),
      fmtBtcAbbr(w.after / w.members),
      deltaStr,
      d ? fmtDmg(d.damage) : '\u2014',
      fmtBuild(bc.war, bp.war),
      fmtBuild(bc.eco, bp.eco),
      fmtBuildPct(bc.war, bc.eco),
    ]);
  }

  if (data.wealth.length > 0) {
    const wt = sumWealthDelta(data.wealth);
    const wds = wt.delta >= 0 ? `+${wt.delta.toFixed(2)}` : wt.delta.toFixed(2);
    const dt = sumDamage(data.damage);
    const bcArr = [...data.buildCounts.values()];
    const bpArr = [...data.buildCountsPrev.values()];
    const totalWar = bcArr.reduce((s, c) => s + c.war, 0);
    const totalEco = bcArr.reduce((s, c) => s + c.eco, 0);
    const prevWar = bpArr.reduce((s, c) => s + c.war, 0);
    const prevEco = bpArr.reduce((s, c) => s + c.eco, 0);
    rows.push([
      'TOTAL', String(wt.members),
      fmtBtcAbbr(wt.after),
      fmtBtcAbbr(wt.warAfter),
      fmtBtcAbbr(wt.after / wt.members),
      wds,
      fmtDmg(dt),
      fmtBuild(totalWar, prevWar),
      fmtBuild(totalEco, prevEco),
      fmtBuildPct(totalWar, totalEco),
    ]);
  }

  return rows;
}

function sectionTitle(y: number, label: string): string {
  return `<text x="${PAD}" y="${y + 20}" font-family="Arial,sans-serif" font-size="16" font-weight="bold" fill="${DARK}">${esc(label)}</text>`;
}

async function main() {
  const _t0 = Date.now();
  const ts = () => ((Date.now() - _t0) / 1000).toFixed(1) + 's';

  const alliances = loadAlliances();
  const beerAlliance = alliances.get('B.E.E.R');
  if (!beerAlliance) { console.error('B.E.E.R not found'); process.exit(1); }

  const beerIds = new Set(beerAlliance.countryIds);

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
  for (const a of alliances.values()) {
    for (const id of a.countryIds) allBattleCountryIds.add(id);
  }

  const countryNameMap = new Map<string, string>();
  if (allBattleCountryIds.size > 0) {
    const cph = [...allBattleCountryIds].map(() => '?').join(',');
    const cRows = db.prepare(`SELECT id, name FROM countries WHERE id IN (${cph})`).all(...allBattleCountryIds) as { id: string; name: string }[];
    for (const r of cRows) countryNameMap.set(r.id, r.name);
  }

  const battles = loadTopBattles(beerIds, countryNameMap, 5);
  console.log(`[${ts()}] battles loaded: ${battles.length}`);

  const dateStr = dominantDate();
  const history = loadAllHistory(alliances, countryNameMap, dateStr);
  console.log(`[${ts()}] history loaded`);

  // ── Build SVG ──
  let y = 0;
  const parts: string[] = [];

  // Top bar
  parts.push(rect(0, y, W, 80, BEER_BLUE));
  parts.push(`<text x="${PAD}" y="38" font-family="Arial,sans-serif" font-size="24" font-weight="bold" fill="${WHITE}">B.E.E.R War Update</text>`);
  parts.push(`<text x="${PAD}" y="62" font-family="Arial,sans-serif" font-size="13" fill="#bfdbfe">${esc(dateStr)}</text>`);
  y = 90;

  y += 52;

  // ── Battles table ──
  parts.push(rect(PAD, y, CW, 2, BEER_BLUE, 1));
  parts.push(sectionTitle(y + 8, `Top ${battles.length} Battles (last 24h)`));
  y += 38;

  if (battles.length > 0) {
    const battleCols: ColDef[] = [
      { label: '#', w: 30 },
      { label: 'Attacker', w: 140, align: 'left' },
      { label: 'Defender', w: 140, align: 'left' },
      { label: 'Region', w: 110, align: 'left' },
      { label: 'Total DMG', w: 105 },
      { label: 'B.E.E.R DMG', w: 105 },
      { label: 'Opp DMG', w: 100 },
      { label: 'Rnd', w: 50 },
      { label: 'Status', w: 75 },
      { label: 'B.E.E.R Cost', w: 105 },
      { label: 'Opp Cost', w: 105 },
    ];

    const battleRows: string[][] = [];
    for (const b of battles) {
      const status = b.isActive ? 'Active' : (b.wonBy === b.beerSide ? 'Won' : 'Lost');
      battleRows.push([
        String(b.rank),
        b.attacker,
        b.defender,
        b.defenderRegion,
        fmtDmg(b.totalDmg),
        fmtDmg(b.beerDmg),
        fmtDmg(b.oppDmg),
        `${b.attackerWonRounds}:${b.defenderWonRounds}`,
        status,
        fmtBtcShort(b.beerCost),
        fmtBtcShort(b.oppCost),
      ]);
    }
    parts.push(drawTable(y, battleCols, battleRows, BEER_BLUE, BEER_BG));
    y += 30 + battleRows.length * 32;
  } else {
    parts.push(`<text x="${PAD}" y="${y + 20}" font-family="Arial,sans-serif" font-size="13" fill="${MID}">No battles involving B.E.E.R in the last 24 hours.</text>`);
    y += 40;
  }

  y += 24;

  // ── B.E.E.R Stats ──
  parts.push(rect(PAD, y, CW, 2, BEER_BLUE, 1));
  parts.push(sectionTitle(y + 8, 'B.E.E.R Stats \u2014 Wealth, Damage & Builds'));
  y += 38;

  const statsCols: ColDef[] = [
    { label: 'Country', w: 155, align: 'left' },
    { label: 'Mmb', w: 45 },
    { label: 'Liquid Wealth', w: 95 },
    { label: 'War Liq.', w: 90 },
    { label: 'Liquid Avg', w: 85 },
    { label: 'Liquid \u0394', w: 85 },
    { label: 'Damage', w: 100 },
    { label: 'War (\u0394)', w: 80 },
    { label: 'Eco (\u0394)', w: 80 },
    { label: 'W/E %', w: 85 },
  ];

  const { beer: beerData, enemyAlliances } = history;
  const beerRows = buildStatsRows(beerData);
  parts.push(drawStatsTable(y, statsCols, beerRows, BEER_BLUE, BEER_BG));
  y += 28 + beerRows.length * 28;

  y += 24;

  // ── Enemy Alliances Stats ──
  parts.push(rect(PAD, y, CW, 2, ENEMY_RED, 1));
  parts.push(sectionTitle(y + 8, 'Other Alliances \u2014 Wealth, Damage & Builds'));
  y += 38;

  const enemyList: { name: string; data: AllianceData; totalDmg: number }[] = [];
  for (const [name, data] of enemyAlliances) {
    const td = sumDamage(data.damage);
    enemyList.push({ name, data, totalDmg: td });
  }
  enemyList.sort((a, b) => b.totalDmg - a.totalDmg);

  const eCols: ColDef[] = [
    { label: 'Alliance', w: 180, align: 'left' },
    { label: 'Mmb', w: 45 },
    { label: 'Liquid Wealth', w: 95 },
    { label: 'War Liq.', w: 90 },
    { label: 'Liquid Avg', w: 85 },
    { label: 'Liquid \u0394', w: 85 },
    { label: 'Damage', w: 100 },
    { label: 'War (\u0394)', w: 80 },
    { label: 'Eco (\u0394)', w: 80 },
    { label: 'W/E %', w: 85 },
  ];

  if (enemyList.length > 0) {
    const eRows: string[][] = [];
    for (const e of enemyList) {
      const wt = sumWealthDelta(e.data.wealth);
      const deltaStr = (wt.delta >= 0 ? '+' : '') + fmtBtcAbbr(wt.delta);
      const bcArr = [...e.data.buildCounts.values()];
      const bpArr = [...e.data.buildCountsPrev.values()];
      const totalWar = bcArr.reduce((s, c) => s + c.war, 0);
      const totalEco = bcArr.reduce((s, c) => s + c.eco, 0);
      const prevWar = bpArr.reduce((s, c) => s + c.war, 0);
      const prevEco = bpArr.reduce((s, c) => s + c.eco, 0);
      eRows.push([
        e.name,
        String(wt.members),
        fmtBtcAbbr(wt.after),
        fmtBtcAbbr(wt.warAfter),
        fmtBtcAbbr(wt.after / wt.members),
        deltaStr,
        fmtDmg(e.totalDmg),
        fmtBuild(totalWar, prevWar),
        fmtBuild(totalEco, prevEco),
        fmtBuildPct(totalWar, totalEco),
      ]);
    }

    // Totals row
    const allWealth = enemyList.flatMap(e => e.data.wealth);
    const allDamage = enemyList.flatMap(e => e.data.damage);
    if (allWealth.length > 0) {
      const wt = sumWealthDelta(allWealth);
      const wds = (wt.delta >= 0 ? '+' : '') + fmtBtcAbbr(wt.delta);
      const dt = sumDamage(allDamage);
      const totalWar = enemyList.reduce((s, e) => s + [...e.data.buildCounts.values()].reduce((a, b) => a + b.war, 0), 0);
      const totalEco = enemyList.reduce((s, e) => s + [...e.data.buildCounts.values()].reduce((a, b) => a + b.eco, 0), 0);
      const prevWar = enemyList.reduce((s, e) => s + [...e.data.buildCountsPrev.values()].reduce((a, b) => a + b.war, 0), 0);
      const prevEco = enemyList.reduce((s, e) => s + [...e.data.buildCountsPrev.values()].reduce((a, b) => a + b.eco, 0), 0);
      eRows.push([
        'TOTAL', String(wt.members),
        fmtBtcAbbr(wt.after),
        fmtBtcAbbr(wt.warAfter),
        fmtBtcAbbr(wt.after / wt.members),
        wds,
        fmtDmg(dt),
        fmtBuild(totalWar, prevWar),
        fmtBuild(totalEco, prevEco),
        fmtBuildPct(totalWar, totalEco),
      ]);
    }

    parts.push(drawStatsTable(y, eCols, eRows, ENEMY_RED, ENEMY_BG));
    y += 28 + eRows.length * 28;
  } else {
    parts.push(`<text x="${PAD}" y="${y + 20}" font-family="Arial,sans-serif" font-size="13" fill="${MID}">No other alliance data available.</text>`);
    y += 40;
  }

  y += 20;

  // ── Equipment Usage ──
  const equipData = loadEquipmentUsage(beerIds);
  const equipCounts = new Map(equipData.map(e => [e.code, e.count] as const));
  const equipSlots = ['helmet', 'chest', 'gloves', 'pants', 'boots'];
  const levelOrder = [1, 2, 3, 4, 5, 6];
  const weaponDefs = [
    { code: 'knife', lv: 0 }, { code: 'gun', lv: 1 }, { code: 'rifle', lv: 2 },
    { code: 'sniper', lv: 3 }, { code: 'tank', lv: 4 }, { code: 'jet', lv: 5 },
  ];

  y += 16;
  parts.push(rect(PAD, y, CW, 2, BEER_BLUE, 1));
  parts.push(sectionTitle(y + 8, 'Equipment Used \u2014 B.E.E.R (last 24h)'));
  y += 84;

  const cardH = 44;
  const gap = 6;
  const equipCardW = Math.floor((CW - gap * 5) / 6);
  const weaponCardW = Math.floor((CW - gap * 5) / 6);

  // Equipment cards: 5 rows × 5 levels
  for (const slot of equipSlots) {
    let cx = PAD;
    for (const lv of levelOrder) {
      const cnt = equipCounts.get(`${slot}${lv}`) ?? 0;
      const uri = iconDataUri(`${slot}.png`);
      parts.push(rect(cx, y - cardH + 2, equipCardW, cardH, STUFE_COLORS[lv - 1], 6));
      parts.push(`<image href="${uri}" x="${cx + 6}" y="${y - cardH + 8}" width="26" height="26"/>`);
      if (cnt > 0) {
        parts.push(cell(cx + 34, y - cardH + 2, equipCardW - 34, cardH, String(cnt),
          { color: WHITE, bold: true, size: 13, align: 'right' }));
      }
      cx += equipCardW + gap;
    }
    y += cardH + gap;
  }

  y += 4;

  // Weapons cards: 6 in a row, no labels
  let wx = PAD;
  for (const w of weaponDefs) {
    const cnt = equipCounts.get(w.code) ?? 0;
    const uri = iconDataUri(`${w.code}.png`);
    parts.push(rect(wx, y - cardH + 2, weaponCardW, cardH, STUFE_COLORS[w.lv], 6));
    parts.push(`<image href="${uri}" x="${wx + 6}" y="${y - cardH + 8}" width="26" height="26"/>`);
    if (cnt > 0) {
      parts.push(cell(wx + 34, y - cardH + 2, weaponCardW - 34, cardH, String(cnt),
        { color: WHITE, bold: true, size: 13, align: 'right' }));
    }
    wx += weaponCardW + gap;
  }
  y += cardH + 8;

  // Footer
  parts.push(line(PAD, y, PAD + CW, y, BORDER, 1));
  parts.push(`<text x="${PAD}" y="${y + 18}" font-family="Arial,sans-serif" font-size="11" fill="${MID}">Generated by Schnabeltier</text>`);
  parts.push(`<text x="${PAD + CW}" y="${y + 18}" font-family="Arial,sans-serif" font-size="10" fill="${MID}" text-anchor="end">Liquid assets = Item + Equipment + Weapon + Money wealth</text>`);

  const H = y + 30;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect x="0" y="0" width="${W}" height="${H}" fill="${WHITE}"/>
  ${parts.join('\n  ')}
</svg>`;

  // ── Render PNG ──
  const outDir = path.resolve(__dirname, '..', 'reports');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `beer-war-update-${dateStr}.png`);

  const outInfo = await sharp(Buffer.from(svg, 'utf-8'), { density: 144 })
    .png()
    .toFile(outFile);

  console.log(`[${ts()}] PNG saved to ${outFile} (${outInfo.width}x${outInfo.height})`);

  // ── Post to Discord ──
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  const threadId = process.env.DISCORD_WEBHOOK_THREAD_ID;
  if (webhookUrl) {
    try {
      const form = new FormData();
      const blob = new Blob([fs.readFileSync(outFile)]);
      form.append('file', blob, `beer-war-update-${dateStr}.png`);
      form.append('payload_json', JSON.stringify({
        content: `**B.E.E.R War Update — ${dateStr}**`,
      }));
      const url = threadId ? `${webhookUrl}?thread_id=${threadId}` : webhookUrl;
      const res = await fetch(url, { method: 'POST', body: form });
      if (res.ok) console.log(`  Posted to Discord (TestingBot)`);
      else console.error(`  Discord webhook failed: ${res.status} ${res.statusText}`);
    } catch (err) {
      console.error(`  Discord webhook error:`, err);
    }
  }

  console.log('');
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
