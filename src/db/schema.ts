const SNAPSHOTS_TABLE = `
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL,
  entity_id TEXT,
  data JSON NOT NULL,
  fetched_at TEXT NOT NULL,
  metadata JSON
);`;

const SNAPSHOTS_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_snapshots_endpoint ON snapshots(endpoint)`,
  `CREATE INDEX IF NOT EXISTS idx_snapshots_fetched ON snapshots(fetched_at)`,
  `CREATE INDEX IF NOT EXISTS idx_snapshots_entity ON snapshots(entity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_snapshots_endpoint_fetched ON snapshots(endpoint, fetched_at)`,
];

const SCRAPE_RUNS_TABLE = `
CREATE TABLE IF NOT EXISTS scrape_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scraper TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  items_fetched INTEGER DEFAULT 0,
  error TEXT
);`;

const COUNTRIES_TABLE = `
CREATE TABLE IF NOT EXISTS countries (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT,
  development REAL DEFAULT 0,
  core_development REAL DEFAULT 0,
  current_development REAL DEFAULT 0,
  average_development REAL DEFAULT 0,
  money REAL DEFAULT 0,
  allies TEXT,
  enemy TEXT,
  wars_with TEXT,
  defensive_pacts TEXT,
  non_aggression_until TEXT,
  ruling_party TEXT,
  pinned_article TEXT,
  discord_url TEXT,
  specialized_item TEXT,
  scheme TEXT,
  map_accent TEXT,
  current_battle_order TEXT,
  orgs TEXT,
  created_at TEXT,
  updated_at TEXT,
  tax_income REAL DEFAULT 0,
  tax_market REAL DEFAULT 0,
  tax_self_work REAL DEFAULT 0,
  unrest_bar REAL DEFAULT 0,
  unrest_bar_max REAL DEFAULT 0,
  unrest_last_contribution_at TEXT,
  strategic_resources TEXT,
  strategic_dev_bonus REAL DEFAULT 0,
  strategic_prod_bonus REAL DEFAULT 0,
  rankings TEXT,
  first_seen TEXT NOT NULL,
  last_updated TEXT NOT NULL
);`;

const USERS_TABLE = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT,
  country TEXT,
  is_active INTEGER DEFAULT 0,
  level INTEGER DEFAULT 0,
  total_xp REAL DEFAULT 0,
  total_skill_points INTEGER DEFAULT 0,
  military_rank INTEGER DEFAULT 0,
  last_connection_at TEXT,
  damages REAL DEFAULT 0,
  wealth REAL DEFAULT 0,
  wealth_companies REAL DEFAULT 0,
  wealth_items REAL DEFAULT 0,
  wealth_money REAL DEFAULT 0,
  wealth_equipments REAL DEFAULT 0,
  wealth_weapons REAL DEFAULT 0,
  weekly_damages REAL DEFAULT 0,
  avatar_url TEXT,
  skill_energy_level INTEGER DEFAULT 0,
  skill_energy_data TEXT,
  skill_health_level INTEGER DEFAULT 0,
  skill_health_data TEXT,
  skill_hunger_level INTEGER DEFAULT 0,
  skill_hunger_data TEXT,
  skill_attack_level INTEGER DEFAULT 0,
  skill_attack_data TEXT,
  skill_companies_level INTEGER DEFAULT 0,
  skill_companies_data TEXT,
  skill_entrepreneurship_level INTEGER DEFAULT 0,
  skill_entrepreneurship_data TEXT,
  skill_production_level INTEGER DEFAULT 0,
  skill_production_data TEXT,
  skill_critical_chance_level INTEGER DEFAULT 0,
  skill_critical_chance_data TEXT,
  skill_critical_damages_level INTEGER DEFAULT 0,
  skill_critical_damages_data TEXT,
  skill_armor_level INTEGER DEFAULT 0,
  skill_armor_data TEXT,
  skill_precision_level INTEGER DEFAULT 0,
  skill_precision_data TEXT,
  skill_dodge_level INTEGER DEFAULT 0,
  skill_dodge_data TEXT,
  skill_loot_chance_level INTEGER DEFAULT 0,
  skill_loot_chance_data TEXT,
  skill_management_level INTEGER DEFAULT 0,
  skill_management_data TEXT,
  rankings TEXT,
  created_at TEXT,
  first_seen TEXT NOT NULL,
  last_updated TEXT NOT NULL
);`;

const BATTLES_TABLE = `
CREATE TABLE IF NOT EXISTS battles (
  id TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL,
  last_updated TEXT NOT NULL,
  war_id TEXT,
  type TEXT,
  is_active INTEGER,
  rounds_to_win INTEGER,
  created_at TEXT,
  updated_at TEXT,
  ended_at TEXT,
  won_by TEXT,
  is_big_battle INTEGER,
  is_resistance INTEGER,
  attacker_country TEXT,
  attacker_won_rounds INTEGER,
  attacker_damages REAL,
  attacker_hit_count INTEGER,
  attacker_money_pool REAL,
  attacker_money_per_1k_damages REAL,
  attacker_bounty_effective_at TEXT,
  defender_country TEXT,
  defender_region TEXT,
  defender_won_rounds INTEGER,
  defender_damages REAL,
  defender_hit_count INTEGER,
  defender_money_pool REAL,
  defender_money_per_1k_damages REAL,
  defender_bounty_effective_at TEXT
);`;

const BATTLE_ROUNDS_TABLE = `
CREATE TABLE IF NOT EXISTS battle_rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  battle_id TEXT NOT NULL REFERENCES battles(id),
  number INTEGER NOT NULL,
  won_by TEXT,
  attacker_damages REAL,
  defender_damages REAL,
  attacker_points INTEGER,
  defender_points INTEGER,
  is_active INTEGER DEFAULT 0,
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(battle_id, number)
);`;

const BATTLE_COUNTRY_ORDERS_TABLE = `
CREATE TABLE IF NOT EXISTS battle_country_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  battle_id TEXT NOT NULL REFERENCES battles(id),
  country_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('attacker', 'defender')),
  created_at TEXT NOT NULL,
  UNIQUE(battle_id, country_id, side)
);`;

const BATTLE_MU_ORDERS_TABLE = `
CREATE TABLE IF NOT EXISTS battle_mu_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  battle_id TEXT NOT NULL REFERENCES battles(id),
  mu_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('attacker', 'defender')),
  created_at TEXT NOT NULL,
  UNIQUE(battle_id, mu_id, side)
);`;

const COMPANIES_TABLE = `
CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT,
  item_code TEXT,
  region TEXT,
  owner_id TEXT,
  worker_count INTEGER DEFAULT 0,
  production REAL DEFAULT 0,
  estimated_value REAL DEFAULT 0,
  is_full INTEGER DEFAULT 0,
  concrete_invested REAL DEFAULT 0,
  storage_level INTEGER DEFAULT 0,
  automated_engine_level INTEGER DEFAULT 0,
  strategic_bonus REAL DEFAULT 0,
  deposit_bonus REAL DEFAULT 0,
  ethic_specialization_bonus REAL DEFAULT 0,
  ethic_deposit_bonus REAL DEFAULT 0,
  total_bonus REAL DEFAULT 0,
  first_seen TEXT NOT NULL,
  last_updated TEXT NOT NULL
);`;

const COMPANY_WORKERS_TABLE = `
CREATE TABLE IF NOT EXISTS company_workers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL REFERENCES companies(id),
  user_id TEXT NOT NULL,
  wage REAL,
  fidelity INTEGER DEFAULT 0,
  joined_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(company_id, user_id)
);`;

const DONATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS donations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  country_id TEXT,
  mu_id TEXT,
  party_id TEXT,
  amount REAL NOT NULL,
  created_at TEXT NOT NULL
);`;

const PARTIES_TABLE = `
CREATE TABLE IF NOT EXISTS parties (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  country_id TEXT NOT NULL,
  region TEXT,
  description TEXT,
  leader TEXT,
  council_members TEXT,
  members TEXT,
  treasurer TEXT,
  primary_winner TEXT,
  avatar_url TEXT,
  ethics_militarism REAL DEFAULT 0,
  ethics_isolationism REAL DEFAULT 0,
  ethics_imperialism REAL DEFAULT 0,
  ethics_industrialism REAL DEFAULT 0,
  ethics_unethical INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  first_seen TEXT NOT NULL,
  last_updated TEXT NOT NULL
);`;

const REGIONS_TABLE = `
CREATE TABLE IF NOT EXISTS regions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT,
  country_id TEXT,
  country_code TEXT,
  biome TEXT,
  climate TEXT,
  is_capital INTEGER DEFAULT 0,
  is_linked_to_capital INTEGER DEFAULT 0,
  has_coast INTEGER DEFAULT 0,
  development REAL DEFAULT 0,
  base_development REAL DEFAULT 0,
  resistance REAL DEFAULT 0,
  resistance_max REAL DEFAULT 0,
  initial_country TEXT,
  main_city TEXT,
  strategic_resource TEXT,
  active_battle_id TEXT,
  neighbors TEXT,
  position TEXT,
  stats TEXT,
  deposit TEXT,
  active_upgrade_levels TEXT,
  upgrades TEXT,
  last_battle_ended_at TEXT,
  last_resistance_contribution_at TEXT,
  last_revolt_ended_at TEXT,
  first_seen TEXT NOT NULL,
  last_updated TEXT NOT NULL
);`;

const ITEM_PRICES_TABLE = `
CREATE TABLE IF NOT EXISTS item_prices (
  fetched_at TEXT PRIMARY KEY,
  ammo REAL DEFAULT 0,
  bread REAL DEFAULT 0,
  case1 REAL DEFAULT 0,
  case2 REAL DEFAULT 0,
  coca REAL DEFAULT 0,
  cocain REAL DEFAULT 0,
  concrete REAL DEFAULT 0,
  cookedFish REAL DEFAULT 0,
  fish REAL DEFAULT 0,
  grain REAL DEFAULT 0,
  heavyAmmo REAL DEFAULT 0,
  iron REAL DEFAULT 0,
  lead REAL DEFAULT 0,
  lightAmmo REAL DEFAULT 0,
  limestone REAL DEFAULT 0,
  livestock REAL DEFAULT 0,
  oil REAL DEFAULT 0,
  paper REAL DEFAULT 0,
  petroleum REAL DEFAULT 0,
  scraps REAL DEFAULT 0,
  steak REAL DEFAULT 0,
  steel REAL DEFAULT 0,
  wood REAL DEFAULT 0
);`;

const MILITARY_UNITS_TABLE = `
CREATE TABLE IF NOT EXISTS military_units (
  id TEXT PRIMARY KEY,
  name TEXT,
  owner_id TEXT,
  region TEXT,
  level INTEGER DEFAULT 0,
  managers TEXT,
  commanders TEXT,
  members TEXT,
  member_count INTEGER DEFAULT 0,
  reputation REAL DEFAULT 0,
  upgrade_levels TEXT,
  avatar_url TEXT,
  weekly_damages REAL DEFAULT 0,
  bounty REAL DEFAULT 0,
  wealth REAL DEFAULT 0,
  damages REAL DEFAULT 0,
  terrain REAL DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  first_seen TEXT NOT NULL,
  last_updated TEXT NOT NULL
);`;

const ALLIANCES_TABLE = `
CREATE TABLE IF NOT EXISTS alliances (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scheme TEXT,
  map_accent TEXT,
  leader TEXT,
  member_countries TEXT,
  current_development REAL DEFAULT 0,
  core_development REAL DEFAULT 0,
  average_development REAL DEFAULT 0,
  is_disbanded INTEGER DEFAULT 0,
  disbanded_at TEXT,
  created_at TEXT,
  updated_at TEXT,
  first_seen TEXT NOT NULL,
  last_updated TEXT NOT NULL
);`;

const USER_HISTORY_TABLE = `
CREATE TABLE IF NOT EXISTS user_history (
  fetched_at TEXT NOT NULL,
  id TEXT NOT NULL,
  country TEXT,
  level INTEGER DEFAULT 0,
  damages REAL DEFAULT 0,
  damages_delta REAL DEFAULT 0,
  wealth REAL DEFAULT 0,
  wealth_companies REAL DEFAULT 0,
  wealth_items REAL DEFAULT 0,
  wealth_money REAL DEFAULT 0,
  wealth_equipments REAL DEFAULT 0,
  wealth_weapons REAL DEFAULT 0,
  weekly_damages REAL DEFAULT 0,
  skill_energy_level INTEGER DEFAULT 0,
  skill_energy_data TEXT,
  skill_health_level INTEGER DEFAULT 0,
  skill_health_data TEXT,
  skill_hunger_level INTEGER DEFAULT 0,
  skill_hunger_data TEXT,
  skill_attack_level INTEGER DEFAULT 0,
  skill_attack_data TEXT,
  skill_companies_level INTEGER DEFAULT 0,
  skill_companies_data TEXT,
  skill_entrepreneurship_level INTEGER DEFAULT 0,
  skill_entrepreneurship_data TEXT,
  skill_production_level INTEGER DEFAULT 0,
  skill_production_data TEXT,
  skill_critical_chance_level INTEGER DEFAULT 0,
  skill_critical_chance_data TEXT,
  skill_critical_damages_level INTEGER DEFAULT 0,
  skill_critical_damages_data TEXT,
  skill_armor_level INTEGER DEFAULT 0,
  skill_armor_data TEXT,
  skill_precision_level INTEGER DEFAULT 0,
  skill_precision_data TEXT,
  skill_dodge_level INTEGER DEFAULT 0,
  skill_dodge_data TEXT,
  skill_loot_chance_level INTEGER DEFAULT 0,
  skill_loot_chance_data TEXT,
  skill_management_level INTEGER DEFAULT 0,
  skill_management_data TEXT,
  rankings TEXT,
  PRIMARY KEY (fetched_at, id)
);`;

const USER_HISTORY_INDEX = `
CREATE INDEX IF NOT EXISTS idx_user_history_id_fetched ON user_history(id, fetched_at);
`;

const WAR_TABLE = `
CREATE TABLE IF NOT EXISTS wars (
  id TEXT PRIMARY KEY,
  is_active INTEGER DEFAULT 0,
  attacker_country TEXT,
  attacker_won_battles INTEGER DEFAULT 0,
  attacker_won_rounds INTEGER DEFAULT 0,
  attacker_damages REAL DEFAULT 0,
  defender_country TEXT,
  defender_won_battles INTEGER DEFAULT 0,
  defender_won_rounds INTEGER DEFAULT 0,
  defender_damages REAL DEFAULT 0,
  priority_country TEXT,
  priority_end_at TEXT,
  battles TEXT,
  created_at TEXT,
  updated_at TEXT,
  first_seen TEXT NOT NULL,
  last_updated TEXT NOT NULL
);`;

const COUNTRY_HISTORY_TABLE = `
CREATE TABLE IF NOT EXISTS country_history (
  fetched_at TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT,
  code TEXT,
  core_development REAL DEFAULT 0,
  current_development REAL DEFAULT 0,
  average_development REAL DEFAULT 0,
  money REAL DEFAULT 0,
  tax_income REAL DEFAULT 0,
  tax_market REAL DEFAULT 0,
  tax_self_work REAL DEFAULT 0,
  unrest_bar REAL DEFAULT 0,
  unrest_bar_max REAL DEFAULT 0,
  allies TEXT,
  enemy TEXT,
  wars_with TEXT,
  defensive_pacts TEXT,
  rankings TEXT,
  PRIMARY KEY (fetched_at, id)
);`;

const COUNTRY_HISTORY_INDEX = `
CREATE INDEX IF NOT EXISTS idx_country_history_id_fetched ON country_history(id, fetched_at);
`;

export const CREATE_TABLES = [
  SNAPSHOTS_TABLE,
  ...SNAPSHOTS_INDEXES,
  SCRAPE_RUNS_TABLE,
  COUNTRIES_TABLE,
  USERS_TABLE,
  BATTLES_TABLE,
  BATTLE_ROUNDS_TABLE,
  BATTLE_COUNTRY_ORDERS_TABLE,
  BATTLE_MU_ORDERS_TABLE,
  COMPANIES_TABLE,
  COMPANY_WORKERS_TABLE,
  DONATIONS_TABLE,
  PARTIES_TABLE,
  REGIONS_TABLE,
  ITEM_PRICES_TABLE,
  MILITARY_UNITS_TABLE,
  ALLIANCES_TABLE,
  WAR_TABLE,
  USER_HISTORY_TABLE,
  USER_HISTORY_INDEX,
  COUNTRY_HISTORY_TABLE,
  COUNTRY_HISTORY_INDEX,
];
