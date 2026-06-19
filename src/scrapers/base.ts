import type Database from 'better-sqlite3';
import type { APIClient } from '@wareraprojects/api';

export interface ScraperDefinition {
  name: string;
  intervalMs: number;
  scheduleHours?: number[];
  execute: (client: APIClient, db: Database.Database) => Promise<void>;
}

export function storeSnapshot(
  db: Database.Database,
  endpoint: string,
  entityId: string | null,
  data: unknown,
  metadata?: Record<string, unknown>,
) {
  const stmt = db.prepare(`
    INSERT INTO snapshots (endpoint, entity_id, data, fetched_at, metadata)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(
    endpoint,
    entityId,
    JSON.stringify(data),
    new Date().toISOString(),
    metadata ? JSON.stringify(metadata) : null,
  );
}

export function startScrapeRun(
  db: Database.Database,
  scraperName: string,
): number {
  const stmt = db.prepare(`
    INSERT INTO scrape_runs (scraper, started_at, status)
    VALUES (?, ?, 'running')
  `);
  const result = stmt.run(scraperName, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

export function completeScrapeRun(
  db: Database.Database,
  runId: number,
  itemsFetched: number,
  error?: string,
) {
  const stmt = db.prepare(`
    UPDATE scrape_runs
    SET completed_at = ?, status = ?, items_fetched = ?, error = ?
    WHERE id = ?
  `);
  stmt.run(
    new Date().toISOString(),
    error ? 'failed' : 'completed',
    itemsFetched,
    error ?? null,
    runId,
  );
}

const SKILL_NAMES = [
  'energy', 'health', 'hunger', 'attack', 'companies',
  'entrepreneurship', 'production', 'critical_chance', 'critical_damages',
  'armor', 'precision', 'dodge', 'loot_chance', 'management',
] as const;

const SKILL_API_KEY: Record<string, string> = {
  energy: 'energy',
  health: 'health',
  hunger: 'hunger',
  attack: 'attack',
  companies: 'companies',
  entrepreneurship: 'entrepreneurship',
  production: 'production',
  critical_chance: 'criticalChance',
  critical_damages: 'criticalDamages',
  armor: 'armor',
  precision: 'precision',
  dodge: 'dodge',
  loot_chance: 'lootChance',
  management: 'management',
};

const WEALTH_BREAKDOWN_COLS = [
  'wealth_companies', 'wealth_items', 'wealth_money', 'wealth_equipments', 'wealth_weapons',
] as const;

const USER_BASE_COLS = [
  'id', 'username', 'country', 'is_active',
  'level', 'total_xp', 'total_skill_points', 'military_rank',
  'last_connection_at',
  'damages', 'wealth', ...WEALTH_BREAKDOWN_COLS, 'weekly_damages',
  'avatar_url',
];

const USER_SKILL_COLS = SKILL_NAMES.flatMap(s => [`skill_${s}_level`, `skill_${s}_data`]);

const USER_EXTRA_COLS = ['rankings', 'created_at', 'first_seen', 'last_updated'];

const USER_ALL_COLS = [...USER_BASE_COLS, ...USER_SKILL_COLS, ...USER_EXTRA_COLS];

const USER_UPDATE_COLS = USER_ALL_COLS.filter(c => c !== 'id' && c !== 'first_seen');

function buildUserUpsertSQL(): { sql: string; stmt: { run: (...args: any[]) => any } } {
  const placeholders = USER_ALL_COLS.map(() => '?').join(', ');
  const updateSet = USER_UPDATE_COLS.map(c => `      ${c} = excluded.${c}`).join(',\n');
  const sql = `
    INSERT INTO users (${USER_ALL_COLS.join(', ')})
    VALUES (${placeholders})
    ON CONFLICT(id) DO UPDATE SET
${updateSet}
  `;
  return { sql, stmt: null as any };
}

let userUpsertStmt: { sql: string; stmt: any } | null = null;

function getUserUpsertStmt(db: Database.Database) {
  if (!userUpsertStmt) {
    const built = buildUserUpsertSQL();
    built.stmt = db.prepare(built.sql);
    userUpsertStmt = built;
  }
  return userUpsertStmt.stmt;
}

function extractWealthBreakdown(u: any): Record<string, number> {
  const src = (typeof u.wealth === 'object' && u.wealth !== null) ? u.wealth
    : (typeof u.stats?.wealth === 'object' && u.stats?.wealth !== null) ? u.stats.wealth
    : {};
  return {
    companies: src.companies ?? 0,
    items: src.items ?? 0,
    money: src.money ?? 0,
    equipments: src.equipments ?? 0,
    weapons: src.weapons ?? 0,
  };
}

export function upsertUser(db: Database.Database, user: Record<string, unknown>) {
  const now = new Date().toISOString();
  const u = user as any;
  const lvl = u.leveling || {};
  const dates = u.dates || {};
  const rankings = u.rankings || {};
  const skills = u.skills || {};
  const w = extractWealthBreakdown(u);

  const vals: any[] = [
    u._id,
    u.username ?? null,
    u.country ?? null,
    u.isActive ? 1 : 0,
    lvl.level ?? 0,
    lvl.totalXp ?? 0,
    lvl.totalSkillPoints ?? 0,
    u.militaryRank ?? 0,
    dates.lastConnectionAt ?? null,
    rankings.userDamages?.value ?? u.stats?.damagesCount ?? 0,
    rankings.userWealth?.value ?? 0,
    w.companies,
    w.items,
    w.money,
    w.equipments,
    w.weapons,
    rankings.weeklyUserDamages?.value ?? 0,
    u.avatarUrl ?? null,
  ];

  for (const name of SKILL_NAMES) {
    const apiKey = SKILL_API_KEY[name];
    const sk = skills[apiKey] || {};
    vals.push(sk.level ?? 0);
    vals.push(JSON.stringify(sk));
  }

  vals.push(
    rankings ? JSON.stringify(rankings) : null,
    u.createdAt ?? null,
    now,
    now,
  );

  const stmt = getUserUpsertStmt(db);
  stmt.run(...vals);
}

export function upsertCountry(db: Database.Database, country: Record<string, unknown>) {
  const now = new Date().toISOString();
  const c = country as any;
  const ranks = c.rankings as Record<string, unknown> | undefined;
  const taxes = c.taxes as Record<string, unknown> | undefined;
  const unrest = c.unrest as Record<string, unknown> | undefined;
  const sr = c.strategicResources as Record<string, unknown> | undefined;
  const srBonuses = sr?.bonuses as Record<string, unknown> | undefined;

  const stmt = db.prepare(`
    INSERT INTO countries (
      id, name, code, development, core_development, current_development, average_development, money,
      allies, enemy, wars_with, defensive_pacts, non_aggression_until, ruling_party, pinned_article,
      discord_url, specialized_item, scheme, map_accent, current_battle_order,
      orgs, created_at, updated_at,
      tax_income, tax_market, tax_self_work,
      unrest_bar, unrest_bar_max, unrest_last_contribution_at,
      strategic_resources, strategic_dev_bonus, strategic_prod_bonus,
      rankings,
      first_seen, last_updated
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?,
      ?, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      code = excluded.code,
      development = excluded.development,
      core_development = excluded.core_development,
      current_development = excluded.current_development,
      average_development = excluded.average_development,
      money = excluded.money,
      allies = excluded.allies,
      enemy = excluded.enemy,
      wars_with = excluded.wars_with,
      defensive_pacts = excluded.defensive_pacts,
      non_aggression_until = excluded.non_aggression_until,
      ruling_party = excluded.ruling_party,
      pinned_article = excluded.pinned_article,
      discord_url = excluded.discord_url,
      specialized_item = excluded.specialized_item,
      scheme = excluded.scheme,
      map_accent = excluded.map_accent,
      current_battle_order = excluded.current_battle_order,
      orgs = excluded.orgs,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      tax_income = excluded.tax_income,
      tax_market = excluded.tax_market,
      tax_self_work = excluded.tax_self_work,
      unrest_bar = excluded.unrest_bar,
      unrest_bar_max = excluded.unrest_bar_max,
      unrest_last_contribution_at = excluded.unrest_last_contribution_at,
      strategic_resources = excluded.strategic_resources,
      strategic_dev_bonus = excluded.strategic_dev_bonus,
      strategic_prod_bonus = excluded.strategic_prod_bonus,
      rankings = excluded.rankings,
      last_updated = excluded.last_updated
  `);
  stmt.run(
    c._id,
    c.name ?? c._id,
    c.code ?? null,
    c.averageDevelopment ?? c.coreDevelopment ?? c.development ?? 0,
    c.coreDevelopment ?? c.development ?? 0,
    c.currentDevelopment ?? c.development ?? 0,
    c.averageDevelopment ?? c.development ?? 0,
    c.money ?? 0,

    c.allies ? JSON.stringify(c.allies) : null,
    c.enemy ?? null,
    c.warsWith ? JSON.stringify(c.warsWith) : null,
    c.defensivePacts ? JSON.stringify(c.defensivePacts) : null,
    c.nonAggressionUntil ? JSON.stringify(c.nonAggressionUntil) : null,
    c.rulingParty ?? null,
    c.pinnedArticle ?? null,

    c.discordUrl ?? null,
    c.specializedItem ?? null,
    c.scheme ?? null,
    c.mapAccent ?? null,
    c.currentBattleOrder ?? null,

    c.orgs ? JSON.stringify(c.orgs) : null,
    c.createdAt ?? null,
    c.updatedAt ?? null,

    taxes?.income ?? 0,
    taxes?.market ?? 0,
    taxes?.selfWork ?? 0,

    unrest?.bar ?? 0,
    unrest?.barMax ?? 0,
    unrest?.lastContributionAt ?? null,

    sr ? JSON.stringify(sr) : null,
    srBonuses?.developmentPercent ?? 0,
    srBonuses?.productionPercent ?? 0,

    ranks ? JSON.stringify(ranks) : null,

    now,
    now,
  );
}

export function upsertBattle(db: Database.Database, battle: Record<string, unknown>) {
  const now = new Date().toISOString();
  const att = battle.attacker as Record<string, unknown> | undefined;
  const def = battle.defender as Record<string, unknown> | undefined;

  const stmt = db.prepare(`
    INSERT INTO battles (
      id, first_seen, last_updated,
      war_id, type, is_active, rounds_to_win, created_at, updated_at, ended_at, won_by,
      is_big_battle, is_resistance,
      attacker_country, attacker_won_rounds, attacker_damages, attacker_hit_count,
      attacker_money_pool, attacker_money_per_1k_damages, attacker_bounty_effective_at,
      defender_country, defender_region, defender_won_rounds, defender_damages, defender_hit_count,
      defender_money_pool, defender_money_per_1k_damages, defender_bounty_effective_at
    ) VALUES (
      ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      last_updated = excluded.last_updated,
      war_id = excluded.war_id,
      type = excluded.type,
      is_active = excluded.is_active,
      rounds_to_win = excluded.rounds_to_win,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      ended_at = excluded.ended_at,
      won_by = excluded.won_by,
      is_big_battle = excluded.is_big_battle,
      is_resistance = excluded.is_resistance,
      attacker_country = excluded.attacker_country,
      attacker_won_rounds = excluded.attacker_won_rounds,
      attacker_damages = excluded.attacker_damages,
      attacker_hit_count = excluded.attacker_hit_count,
      attacker_money_pool = excluded.attacker_money_pool,
      attacker_money_per_1k_damages = excluded.attacker_money_per_1k_damages,
      attacker_bounty_effective_at = excluded.attacker_bounty_effective_at,
      defender_country = excluded.defender_country,
      defender_region = excluded.defender_region,
      defender_won_rounds = excluded.defender_won_rounds,
      defender_damages = excluded.defender_damages,
      defender_hit_count = excluded.defender_hit_count,
      defender_money_pool = excluded.defender_money_pool,
      defender_money_per_1k_damages = excluded.defender_money_per_1k_damages,
      defender_bounty_effective_at = excluded.defender_bounty_effective_at
  `);

  stmt.run(
    battle._id as string, now, now,

    battle.war as string ?? null,
    battle.type as string ?? null,
    battle.isActive ? 1 : 0,
    (battle.roundsToWin as number) ?? null,
    (battle.createdAt as string) ?? null,
    (battle.updatedAt as string) ?? null,
    (battle.endedAt as string) ?? null,
    (battle.wonBy as string) ?? null,

    battle.isBigBattle ? 1 : null,
    battle.isResistance ? 1 : null,

    (att?.country as string) ?? null,
    (att?.wonRoundsCount as number) ?? null,
    (att?.damages as number) ?? null,
    (att?.hitCount as number) ?? null,
    (att?.moneyPool as number) ?? null,
    (att?.moneyPer1kDamages as number) ?? null,
    (att?.bountyEffectiveAt as string) ?? null,

    (def?.country as string) ?? null,
    (def?.region as string) ?? null,
    (def?.wonRoundsCount as number) ?? null,
    (def?.damages as number) ?? null,
    (def?.hitCount as number) ?? null,
    (def?.moneyPool as number) ?? null,
    (def?.moneyPer1kDamages as number) ?? null,
    (def?.bountyEffectiveAt as string) ?? null,
  );

  upsertBattleRounds(db, battle._id as string, battle);
  upsertBattleOrders(db, battle._id as string, 'attacker', battle.attacker as Record<string, unknown> | undefined);
  upsertBattleOrders(db, battle._id as string, 'defender', battle.defender as Record<string, unknown> | undefined);
}

function upsertBattleRounds(db: Database.Database, battleId: string, battle: Record<string, unknown>) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO battle_rounds (battle_id, number, won_by, attacker_damages, defender_damages, attacker_points, defender_points, is_active, started_at, ended_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(battle_id, number) DO UPDATE SET
      won_by = excluded.won_by,
      attacker_damages = excluded.attacker_damages,
      defender_damages = excluded.defender_damages,
      attacker_points = excluded.attacker_points,
      defender_points = excluded.defender_points,
      is_active = excluded.is_active,
      ended_at = excluded.ended_at
  `);

  const cr = battle.currentRound as Record<string, unknown> | undefined;
  if (cr) {
    const crAtt = cr.attacker as Record<string, unknown> | undefined;
    const crDef = cr.defender as Record<string, unknown> | undefined;
    stmt.run(
      battleId,
      (cr.number as number) ?? 1,
      (cr.wonBy as string) ?? null,
      (crAtt?.damages as number) ?? null,
      (crDef?.damages as number) ?? null,
      (crAtt?.points as number) ?? null,
      (crDef?.points as number) ?? null,
      cr.isActive ? 1 : 0,
      (cr.createdAt as string) ?? null,
      (cr.endedAt as string) ?? null,
      now,
    );
  }

  const history = battle.roundsHistory as Array<Record<string, unknown>> | undefined;
  const rounds = battle.rounds as Array<unknown> | undefined;
  if (history) {
    for (let i = 0; i < history.length; i++) {
      const round = history[i];
      stmt.run(
        battleId,
        i + 1,
        (round.wonBy as string) ?? null,
        (round.attackerDamages as number) ?? null,
        (round.defenderDamages as number) ?? null,
        (round.attackerPoints as number) ?? null,
        (round.defenderPoints as number) ?? null,
        0,
        null,
        null,
        now,
      );
    }
  }
}

function upsertBattleCountryOrders(
  db: Database.Database,
  battleId: string,
  side: string,
  orders: Array<unknown>,
) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO battle_country_orders (battle_id, country_id, side, created_at)
    VALUES (?, ?, ?, ?)
  `);
  for (const order of orders) {
    const id = typeof order === 'string' ? order : (order as Record<string, unknown>)._id as string;
    if (id) stmt.run(battleId, id, side, now);
  }
}

function upsertBattleMuOrders(
  db: Database.Database,
  battleId: string,
  side: string,
  orders: Array<unknown>,
) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO battle_mu_orders (battle_id, mu_id, side, created_at)
    VALUES (?, ?, ?, ?)
  `);
  for (const order of orders) {
    const id = typeof order === 'string' ? order : (order as Record<string, unknown>)._id as string;
    if (id) stmt.run(battleId, id, side, now);
  }
}

function upsertBattleOrders(
  db: Database.Database,
  battleId: string,
  side: string,
  sideData: Record<string, unknown> | undefined,
) {
  if (!sideData) return;
  const countryOrders = sideData.countryOrders as Array<unknown> | undefined;
  const muOrders = sideData.muOrders as Array<unknown> | undefined;
  if (countryOrders) upsertBattleCountryOrders(db, battleId, side, countryOrders);
  if (muOrders) upsertBattleMuOrders(db, battleId, side, muOrders);
}

export function upsertCompany(
  db: Database.Database,
  company: Record<string, unknown>,
  bonus?: Record<string, unknown>,
) {
  const now = new Date().toISOString();
  const upgrades = company.activeUpgradeLevels as Record<string, unknown> | undefined;
  const stmt = db.prepare(`
    INSERT INTO companies (
      id, name, item_code, region, owner_id, worker_count,
      production, estimated_value, is_full, concrete_invested,
      storage_level, automated_engine_level,
      strategic_bonus, deposit_bonus, ethic_specialization_bonus, ethic_deposit_bonus, total_bonus,
      first_seen, last_updated
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      item_code = excluded.item_code,
      region = excluded.region,
      owner_id = excluded.owner_id,
      worker_count = excluded.worker_count,
      production = excluded.production,
      estimated_value = excluded.estimated_value,
      is_full = excluded.is_full,
      concrete_invested = excluded.concrete_invested,
      storage_level = excluded.storage_level,
      automated_engine_level = excluded.automated_engine_level,
      strategic_bonus = excluded.strategic_bonus,
      deposit_bonus = excluded.deposit_bonus,
      ethic_specialization_bonus = excluded.ethic_specialization_bonus,
      ethic_deposit_bonus = excluded.ethic_deposit_bonus,
      total_bonus = excluded.total_bonus,
      last_updated = excluded.last_updated
  `);
  stmt.run(
    company._id as string,
    (company.name as string) ?? null,
    (company.itemCode as string) ?? null,
    (company.region as string) ?? null,
    (company.user as string) ?? null,
    (company.workerCount as number) ?? 0,

    (company.production as number) ?? 0,
    (company.estimatedValue as number) ?? 0,
    company.isFull ? 1 : 0,
    (company.concreteInvested as number) ?? 0,

    (upgrades?.storage as number) ?? 0,
    (upgrades?.automatedEngine as number) ?? 0,

    (bonus?.strategicBonus as number) ?? 0,
    (bonus?.depositBonus as number) ?? 0,
    (bonus?.ethicSpecializationBonus as number) ?? 0,
    (bonus?.ethicDepositBonus as number) ?? 0,
    (bonus?.total as number) ?? 0,

    now,
    now,
  );
}

export function upsertCompanyWorker(
  db: Database.Database,
  companyId: string,
  worker: Record<string, unknown>,
) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO company_workers (company_id, user_id, wage, fidelity, joined_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(company_id, user_id) DO UPDATE SET
      wage = excluded.wage,
      fidelity = excluded.fidelity,
      joined_at = excluded.joined_at
  `);
  stmt.run(
    companyId,
    (worker.user as string) ?? null,
    (worker.wage as number) ?? null,
    (worker.fidelity as number) ?? 0,
    (worker.joinedAt as string) ?? null,
    now,
  );
}

export function upsertMilitaryUnit(db: Database.Database, mu: Record<string, unknown>) {
  const now = new Date().toISOString();
  const m = mu as any;
  const leveling = m.leveling as Record<string, unknown> | undefined;
  const roles = m.roles as Record<string, unknown> | undefined;
  const rankings = m.rankings as Record<string, any> | undefined;
  const upgrades = m.activeUpgradeLevels as Record<string, unknown> | undefined;

  const stmt = db.prepare(`
    INSERT INTO military_units (
      id, name, owner_id, region,
      level, managers, commanders, members, member_count,
      reputation, upgrade_levels, avatar_url,
      weekly_damages, bounty, wealth, damages, terrain,
      created_at, updated_at,
      first_seen, last_updated
    ) VALUES (
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?,
      ?, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      owner_id = excluded.owner_id,
      region = excluded.region,
      level = excluded.level,
      managers = excluded.managers,
      commanders = excluded.commanders,
      members = excluded.members,
      member_count = excluded.member_count,
      reputation = excluded.reputation,
      upgrade_levels = excluded.upgrade_levels,
      avatar_url = excluded.avatar_url,
      weekly_damages = excluded.weekly_damages,
      bounty = excluded.bounty,
      wealth = excluded.wealth,
      damages = excluded.damages,
      terrain = excluded.terrain,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      last_updated = excluded.last_updated
  `);
  stmt.run(
    m._id,
    m.name ?? null,
    m.user ?? null,
    m.region ?? null,

    leveling?.level ?? 0,
    roles?.managers ? JSON.stringify(roles.managers) : null,
    roles?.commanders ? JSON.stringify(roles.commanders) : null,
    m.members ? JSON.stringify(m.members) : null,
    (m.members?.length as number) ?? 0,

    m.mercenaryReputation ?? 0,
    upgrades ? JSON.stringify(upgrades) : null,
    m.avatarUrl ?? null,

    rankings?.muWeeklyDamages?.value ?? 0,
    rankings?.muBounty?.value ?? 0,
    rankings?.muWealth?.value ?? 0,
    rankings?.muDamages?.value ?? 0,
    rankings?.muTerrain?.value ?? 0,

    m.createdAt ?? null,
    m.updatedAt ?? null,

    now,
    now,
  );
}

export function insertCountryHistory(db: Database.Database, countries: Record<string, unknown>[], fetchedAt: string) {
  const stmt = db.prepare(`
    INSERT INTO country_history (
      fetched_at, id, name, code,
      core_development, current_development, average_development,
      money,
      tax_income, tax_market, tax_self_work,
      unrest_bar, unrest_bar_max,
      allies, enemy, wars_with, defensive_pacts,
      rankings
    ) VALUES (
      ?, ?, ?, ?,
      ?, ?, ?,
      ?,
      ?, ?, ?,
      ?, ?,
      ?, ?, ?, ?,
      ?
    )
  `);

  const insertBatch = db.transaction((entries: any[]) => {
    for (const raw of entries) {
      const c = raw as any;
      const taxes = c.taxes || {};
      const unrest = c.unrest || {};
      const ranks = c.rankings || {};

      stmt.run(
        fetchedAt,
        c._id,
        c.name ?? null,
        c.code ?? null,

        c.coreDevelopment ?? c.development ?? 0,
        c.currentDevelopment ?? c.development ?? 0,
        c.averageDevelopment ?? c.development ?? 0,

        c.money ?? 0,

        taxes.income ?? 0,
        taxes.market ?? 0,
        taxes.selfWork ?? 0,

        unrest.bar ?? 0,
        unrest.barMax ?? 0,

        c.allies ? JSON.stringify(c.allies) : null,
        c.enemy ?? null,
        c.warsWith ? JSON.stringify(c.warsWith) : null,
        c.defensivePacts ? JSON.stringify(c.defensivePacts) : null,

        ranks ? JSON.stringify(ranks) : null,
      );
    }
  });

  for (let i = 0; i < countries.length; i += 500) {
    insertBatch(countries.slice(i, i + 500));
  }
}

export function insertUserHistory(db: Database.Database, rawUsers: Record<string, unknown>[], fetchedAt: string) {
  const getPrevDamages = db.prepare(
    `SELECT damages FROM user_history WHERE id = ? ORDER BY fetched_at DESC LIMIT 1`,
  );

  const SKILL_NAMES_LOCAL = [
    'energy', 'health', 'hunger', 'attack', 'companies',
    'entrepreneurship', 'production', 'critical_chance', 'critical_damages',
    'armor', 'precision', 'dodge', 'loot_chance', 'management',
  ];

  const API_KEY: Record<string, string> = {
    energy: 'energy', health: 'health', hunger: 'hunger', attack: 'attack',
    companies: 'companies', entrepreneurship: 'entrepreneurship',
    production: 'production', critical_chance: 'criticalChance',
    critical_damages: 'criticalDamages', armor: 'armor',
    precision: 'precision', dodge: 'dodge',
    loot_chance: 'lootChance', management: 'management',
  };

  const wealthBreakdownCols = ['wealth_companies', 'wealth_items', 'wealth_money', 'wealth_equipments', 'wealth_weapons'];
  const skillCols = SKILL_NAMES_LOCAL.flatMap(s => [`skill_${s}_level`, `skill_${s}_data`]);
  const allCols = [
    'fetched_at', 'id', 'country', 'level',
    'damages', 'damages_delta', 'wealth', ...wealthBreakdownCols, 'weekly_damages',
    ...skillCols,
    'rankings',
  ];

  const stmt = db.prepare(`
    INSERT INTO user_history (${allCols.join(', ')})
    VALUES (${allCols.map(() => '?').join(', ')})
  `);

  const insertBatch = db.transaction((entries: any[]) => {
    for (const raw of entries) {
      const r = raw as any;
      const lvl = r.leveling || {};
      const rankings = r.rankings || {};
      const skills = r.skills || {};
      const w = extractWealthBreakdown(r);

      const id = r._id as string;
      const damages = rankings.userDamages?.value ?? r.stats?.damagesCount ?? 0;
      const prevRow = getPrevDamages.get(id) as { damages: number } | undefined;
      const delta = Math.max(0, damages - (prevRow?.damages ?? 0));

      const vals: any[] = [
        fetchedAt, id,
        r.country ?? null,
        lvl.level ?? 0,
        damages, delta,
        rankings.userWealth?.value ?? 0,
        w.companies,
        w.items,
        w.money,
        w.equipments,
        w.weapons,
        rankings.weeklyUserDamages?.value ?? 0,
      ];

      for (const name of SKILL_NAMES_LOCAL) {
        const apiKey = API_KEY[name];
        const sk = skills[apiKey] || {};
        vals.push(sk.level ?? 0);
        vals.push(JSON.stringify(sk));
      }

      vals.push(rankings ? JSON.stringify(rankings) : null);
      stmt.run(...vals);
    }
  });

  for (let i = 0; i < rawUsers.length; i += 500) {
    insertBatch(rawUsers.slice(i, i + 500));
  }
}

export function upsertEquipmentUsage(
  db: Database.Database,
  tx: Record<string, unknown>,
) {
  const item = tx.item as Record<string, unknown> | undefined;
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO equipment_usage (id, code, buyer, seller, transactiontype, skills, state, last_acquisition_at, updated_at, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      code = excluded.code,
      buyer = excluded.buyer,
      seller = excluded.seller,
      transactiontype = excluded.transactiontype,
      skills = excluded.skills,
      state = excluded.state,
      last_acquisition_at = excluded.last_acquisition_at,
      updated_at = excluded.updated_at,
      fetched_at = excluded.fetched_at
  `);
  stmt.run(
    tx._id as string,
    item?.code as string ?? null,
    tx.buyerId as string ?? null,
    tx.sellerId as string ?? null,
    tx.transactionType as string ?? null,
    item?.skills ? JSON.stringify(item.skills) : null,
    (item?.state as number) ?? 0,
    item?.lastAcquisitionAt as string ?? null,
    tx.updatedAt as string ?? null,
    now,
  );
}

export function upsertMercenaryContract(
  db: Database.Database,
  contract: Record<string, unknown>,
) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO mercenary_contracts (id, battle_id, country, for_country, for_country_side, budget, current_payout, current_per_k, initial_per_k, minimum_damage, professionals_only, round_number, status, current_winner, current_winner_user, bids, created_at, updated_at, expires_at, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      battle_id = excluded.battle_id,
      country = excluded.country,
      for_country = excluded.for_country,
      for_country_side = excluded.for_country_side,
      budget = excluded.budget,
      current_payout = excluded.current_payout,
      current_per_k = excluded.current_per_k,
      initial_per_k = excluded.initial_per_k,
      minimum_damage = excluded.minimum_damage,
      professionals_only = excluded.professionals_only,
      round_number = excluded.round_number,
      status = excluded.status,
      current_winner = excluded.current_winner,
      current_winner_user = excluded.current_winner_user,
      bids = excluded.bids,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      expires_at = excluded.expires_at,
      fetched_at = excluded.fetched_at
  `);
  const bids = contract.bids as Array<unknown> | undefined;
  stmt.run(
    contract._id as string,
    contract.battle as string,
    contract.country as string ?? null,
    contract.forCountry as string ?? null,
    contract.forCountrySide as string ?? null,
    (contract.budget as number) ?? 0,
    (contract.currentPayout as number) ?? 0,
    (contract.currentPerK as number) ?? 0,
    (contract.initialPerK as number) ?? 0,
    (contract.minimumDamage as number) ?? 0,
    contract.professionalsOnly ? 1 : 0,
    (contract.roundNumber as number) ?? 0,
    contract.status as string ?? null,
    contract.currentWinner as string ?? null,
    contract.currentWinnerUser as string ?? null,
    bids ? JSON.stringify(bids) : null,
    contract.createdAt as string ?? null,
    contract.updatedAt as string ?? null,
    contract.expiresAt as string ?? null,
    now,
  );
}

export function log(name: string, msg: string) {
  console.log(`[${name}] ${msg}`);
}

export function elapsed(start: number): string {
  const sec = ((Date.now() - start) / 1000).toFixed(1);
  return `${sec}s`;
}

export function pct(part: number, total: number): string {
  if (total === 0) return '0%';
  return `${((part / total) * 100).toFixed(1)}%`;
}

export function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
