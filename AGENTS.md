# Warera Data Scraper

Periodisch die Warera API abfragen, Daten in SQLite speichern und so Änderungen im Zeitverlauf nachvollziehbar machen.

## Tech Stack

- **Runtime:** Node.js (ESM, TypeScript)
- **API-Client:** [`@wareraprojects/api`](https://github.com/WarEraProjects/TRPC) – tRPC-Client mit auto-pagination, batching, rate-limiting
- **Datenbank:** SQLite via `better-sqlite3`
- **Build:** `tsup` (ESM)
- **Dev:** `tsx` – TypeScript direkt ausführen
- **Prozess-Manager:** `pm2` (lokal installiert)

## Setup

```bash
npm install
```

`.env` anlegen (bereits vorhanden):

```env
WARERA_API_KEY=wae_6497d6c62c9723db5a72baeb34e5cfc81f9b9887c425f4a41b064eb9b1aef96c
SCRAPER_DATA_DIR=./data
```

Das API Rate Limit beträgt **500 Requests pro Minute**. API-Calls werden in Batches von 50 parallel ausgeführt, um das Limit optimal auszunutzen.

## Projektstruktur

```
src/
├── config.ts              # Umgebungsvariablen, Intervalle
├── index.ts               # CLI-Entry (--once, --all, watch)
├── scheduler.ts           # Scheduler + initialer Voll-Scrape
├── db/
│   ├── connection.ts      # SQLite-Initialisierung (WAL-Modus)
│   └── schema.ts          # Alle Tabellendefinitionen
└── scrapers/
    ├── base.ts            # Gemeinsame Helfer (Snapshot, Upsert, ScrapeRun-Tracking)
    ├── country.ts         # Länder + Regierungen (30 min)
    ├── event.ts           # Events (5 min)
    ├── battle.ts          # Aktive Schlachten + Rankings (5 min)
    ├── company.ts         # Firmen + Arbeiter, stale cleanup (12 h)
    ├── user.ts            # Benutzer per Country + getUserLite-Batches (24 h)
    ├── ranking.ts         # Alle 27 Ranking-Typen (60 min)
    ├── itemPrice.ts       # Item-Preise column-per-item (6 h)
    ├── mu.ts              # Militäreinheiten (60 min)
    ├── donation.ts        # Spenden pro Land (30 min)
    ├── party.ts           # Parteien pro Land (60 min)
    ├── region.ts          # Alle Regionen (global, 60 min)
    └── misc.ts            # GameConfig, Artikel, Transaktionen (2 h)
scripts/
├── migrate-battles.ts
├── migrate-countries.ts
├── migrate-item-prices.ts
├── migrate-mu.ts
└── migrate-users.ts      # Einmalige Migrationen (data-JSON → flache Spalten)
```

## Datenbank-Schema

### `snapshots`
Jeder API-Call wird als JSON-Schnappschuss gespeichert. Grundlage für zeitbasierte Analysen.

```sql
snapshots (id, endpoint, entity_id, data, fetched_at, metadata)
```

Indizes auf `endpoint`, `entity_id`, `fetched_at` sowie Composite-Index `(endpoint, fetched_at)`.

### Normalisierte Tabellen (alle ohne `data`-JSON-Spalte – Felder flach ausgelegt)

| Tabelle | Beschreibung | Wichtige Spalten |
|---------|-------------|-----------------|
| **countries** | Aktuellster Stand pro Land | 28 Spalten: name, code, money, development, taxes, unrest, strategic_resources, rankings, allies/enemy/wars_with, ruling_party, specialized_item, scheme |
| **users** | Aktuellster Stand pro Benutzer | 44 Spalten: username, country, level, damages, wealth, weekly_damages, 14 Skills × (level+data-JSON), rankings |
| **battles** | Aktuellster Stand pro Schlacht | 28 Spalten: war_id, type, is_active, rounds_to_win, attacker/defender (country, damages, hit_count, money_pool, money_per_1k, bounty), won_by, ended_at |
| **battle_rounds** | Runden pro Schlacht | battle_id, number, won_by, damages/points per Seite, is_active |
| **battle_country_orders** | Länder-Befehle pro Schlacht | battle_id, country_id, side (attacker/defender) |
| **battle_mu_orders** | MU-Befehle pro Schlacht | battle_id, mu_id, side (attacker/defender) |
| **companies** | Aktuellster Stand pro Firma | 14 Spalten: name, item_code, region, owner_id, worker_count, production, estimated_value, upgrades (storage_level, automated_engine_level) |
| **company_workers** | Arbeiter pro Firma | company_id, user_id, wage, fidelity, joined_at |
| **military_units** | Aktuellster Stand pro MU | 21 Spalten: name, owner_id, region, level, managers/commanders/members (JSON), member_count, reputation, weekly_damages, damages, wealth, bounty, terrain |
| **item_prices** | Item-Preise column-per-item | fetched_at (PK), 23 Item-Spalten (ammo, bread, concrete, steel, …) – ein Row pro Scrape, 30-Tage-Retention |
| **donations** | Spenden | user_id, country_id, mu_id, party_id, amount, created_at |
| **parties** | Parteien pro Land | name, country_id, region, leader, council_members, members (JSON), treasurer, ethics (militarism, isolationism, imperialism, industrialism) |
| **regions** | Alle Regionen | name, code, country_id, initial_country, biome, climate, is_capital, development, resistance, strategic_resource, active_battle_id, neighbors, position, upgrades |

### `scrape_runs`
Protokolliert jeden Scrape-Durchlauf (Start, Ende, Status, Items, Fehler).

## Befehle

| Befehl | Beschreibung |
|--------|-------------|
| `npm run dev` | Daemon-Modus (initialer Voll-Scrape, dann Intervalle) |
| `npm run scrape` | Einmaliger Scrape (Events + aktive Schlachten + Item-Preise) |
| `npm run scrape:full` | Einmaliger Voll-Scrape (alle Endpunkte) |
| `npm run watch` | Wie `dev` |
| `npm run build` | Build mit tsup |
| `npm start` | Build-Ausführung (dist/index.js) |

## PM2 (Hintergrundbetrieb + Autostart)

Der Scraper läuft über PM2:

```bash
npx pm2 start npm --name "warera-scraper" -- run dev   # Starten
npx pm2 status                                           # Status prüfen
npx pm2 logs warera-scraper                              # Logs ansehen
npx pm2 stop warera-scraper                              # Stoppen
npx pm2 restart warera-scraper                           # Neustarten
```

**Autostart bei Reboot:** Per `@reboot`-Cron-Eintrag:

```cron
@reboot cd /home/dario/Documents/WareraDataScraper && /home/dario/Documents/WareraDataScraper/node_modules/.bin/pm2 resurrect
```

Logs: `~/.pm2/logs/warera-scraper-*.log`

## Scraping-Intervalle

| Scraper | Intervall | Daten |
|---------|-----------|-------|
| event | 5 min | Events (paginated, max 20 Seiten) |
| battle | 5 min | Aktive Schlachten + Live-Daten + Rankings (27 Kombinationen pro Battle) |
| donation | 30 min | Spenden pro Land (paginated, 10-Tage-Cutoff beim ersten Lauf) |
| country | 30 min | Alle Länder + Regierungen pro Land |
| itemPrice | 6 h | Item-Preise (column-per-item, 30-Tage-Retention) |
| company | 12 h | Alle Firmen (IDs via getCompanies, Details via parallel getById in 50er-Batches) + Arbeiter pro Firma + stale cleanup |
| ranking | 60 min | Alle 27 Ranking-Typen |
| mu | 60 min | Militäreinheiten (paginated, optional getById) |
| party | 60 min | Parteien pro Land (paginated) |
| region | 60 min | Alle Regionen (ein globaler Call: region.getRegionsObject) |
| misc | 2 h | GameConfig, Artikel (paginated), Transaktionen (paginated) |
| user | 24 h | Benutzer per Country (getUsersByCountry → getUserLite in 50er-Batches) |

Besonderheiten:
- **company:** `getCompanies` liefert nur IDs (strings), Details via `getById`. Nach jedem Durchlauf werden stale Companies (in DB aber nicht mehr in API) hart gelöscht (erst Arbeiter, dann Firma).
- **battle:** Finish-Detection via Diff der aktiven Battle-IDs vor/nach dem Scrape. Beendete Battles werden via `getById` final abgerufen.
- **donation:** `getManyPaginated` benötigt zwingend `countryId`-Filter. Erster Lauf holt 10 Tage zurück, Folgeläufe stoppen bei erster bekannter ID.
- **user:** `getUsersByCountry` liefert nur `{_id, createdAt}` – Details via `getUserLite` in 50er-Parallel-Batches.
- **itemPrice:** Unbekannte Item-Codes brechen mit `ALTER TABLE`-Hinweis ab. Neues Item manuell als Spalte in `schema.ts` + DB per `ALTER TABLE item_prices ADD COLUMN` hinzufügen.
- **region:** `getRegionsObject` liefert `Record<string, RegionsObjectItem>`. Das `activeBattle`-Feld (Battle-Summary-Objekt) muss per `JSON.stringify` gespeichert werden, da `better-sqlite3` JS-Objekte als named-parameter Binder interpretiert.

## API-Endpunkte (aktiv gescrapt)

### Länder & Regierung
- `country.getAllCountries` – alle Länder (Liste)
- `country.getCountryById` – **nicht aktiv gescrapt** (Details aus getAllCountries reichen)
- `government.getByCountryId` – Regierung pro Land

### Events
- `event.getEventsPaginated` – Events (alle Typen, paginated)

### Schlachten
- `battle.getBattles` – aktive Schlachten (paginated, isActive: true)
- `battle.getLiveBattleData` – Live-Daten pro aktiver Schlacht
- `battle.getById` – Finale Daten beendeter Schlachten
- `battleRanking.getRanking` – 27 Kombinationen (damage/points/money × user/country/mu × attacker/defender/merged)

### Benutzer
- `user.getUsersByCountry` – Benutzer-IDs pro Land (paginated)
- `user.getUserLite` – Kurzprofil (in 50er-Batches)

### Rankings (27 Typen)
- Länder: wöchentliche Schäden, Entwicklung, Bevölkerung, Vermögen, Boni, Kopfgeld
- Benutzer: Schäden, Vermögen, Level, Referrals, Abos, Gelände, Premium, Fälle, Edelsteine, Kopfgeld
- MUs: Schäden, Gelände, Vermögen, Kopfgeld, Reputation
- `ranking.getRanking({ rankingType })`

### Firmen & Wirtschaft
- `company.getCompanies` – alle Firmen-IDs (paginated)
- `company.getById` – Details pro Firma
- `worker.getWorkers` – Arbeiter pro Firma
- `itemTrading.getPrices` – aktuelle Item-Preise (alle Codes auf einmal)

### Militäreinheiten
- `mu.getManyPaginated` – alle MUs (paginated)
- `mu.getById` – Details pro MU (optional, wenn Pagination unvollständig)

### Spenden & Parteien
- `donation.getManyPaginated` – Spenden pro Land (paginated, benötigt countryId)
- `party.getManyPaginated` – Parteien pro Land (paginated, benötigt countryId)

### Regionen
- `region.getRegionsObject` – alle Regionen als Objekt

### Sonstige
- `gameConfig.getDates` – Spieltermine
- `gameConfig.getGameConfig` – Spielkonfiguration
- `article.getArticlesPaginated` – Artikel (paginated)
- `transaction.getPaginatedTransactions` – Transaktionen (paginated)

### Nicht aktiv gescrapt (obwohl API vorhanden)
`round.getById`, `round.getLastHits`, `battleOrder.getByBattle`, `tradingOrder.getTopOrders`, `workOffer.*`, `upgrade.getUpgradeByTypeAndEntity`, `search.searchAnything`, `inventory.fetchCurrentEquipment`, `mercenaryContractAuction.*`, `battleLootSummary.*`, `election.*`, `tournament.*`

## Daten auswerten

### Nach Endpunkt und Zeitfenster
```sql
SELECT fetched_at, data FROM snapshots
WHERE endpoint = 'country.getAllCountries'
  AND fetched_at BETWEEN '2026-06-01' AND '2026-06-04'
ORDER BY fetched_at;
```

### Letzter Stand einer Entität
```sql
SELECT data FROM snapshots
WHERE endpoint = 'government.getByCountryId'
  AND entity_id = '<countryId>'
ORDER BY fetched_at DESC LIMIT 1;
```

### Entwicklung eines Felds über Zeit
```sql
SELECT fetched_at, json_extract(data, '$.money') as money
FROM snapshots
WHERE endpoint = 'country.getAllCountries'
  AND entity_id = '<countryId>'
ORDER BY fetched_at;
```

### Direkte Abfragen aus normalisierten Tabellen
```sql
-- TOP 10 deutsche MUs nach weekly_damages
SELECT mu.name, mu.weekly_damages, mu.member_count, r.name as region
FROM military_units mu
JOIN regions r ON mu.region = r.id
WHERE r.initial_country = (SELECT id FROM countries WHERE name = 'Germany')
ORDER BY mu.weekly_damages DESC
LIMIT 10;
```

```sql
-- Aktuelle Battle-Teilnahme einer MU
SELECT b.id, b.type, bmo.side, b.attacker_damages, b.defender_damages
FROM battle_mu_orders bmo
JOIN battles b ON bmo.battle_id = b.id
WHERE bmo.mu_id = '<muId>' AND b.is_active = 1;
```

```sql
-- Item-Preise der letzten 7 Tage
SELECT fetched_at, bread, steel, ammo, concrete
FROM item_prices
WHERE fetched_at >= datetime('now', '-7 days')
ORDER BY fetched_at;
```

## Produktions-Bonus Report

Der Report zeigt pro Item die besten Produktionsländer (max. 1 Region pro kontrollierendem Land):

```bash
npm run report:production
```

Alle Preise und Gewinne in **BTC**, Einheit **nach** dem Wert (z. B. `0.173 BTC`).

Bonus-Berechnung pro Item pro Region (kontrolliert von Country C):
- **Deposit:** 30% falls `region.deposit.type == item`
- **Strategische Ressource:** `C.strategic_prod_bonus` falls `C.specialized_item == item`
- **Ethik-Spezialisation:** `|C.ruling_party.ethics_industrialism| * 15` falls `item == C.specialized_item` UND item in industrial/agricultural Kategorie; falls `C.specialized_item == null` gilt der Bonus für **alle** Items der passenden Kategorie
- **Total:** Summe aller drei

Klassifikation der Güter (industrial/agricultural) in `config/production-bonuses.json`.

## Entwicklung

### Neuen Scraper hinzufügen
1. Datei in `src/scrapers/` anlegen
2. `ScraperDefinition`-Objekt exportieren (`name`, `intervalMs`, `execute`)
3. In `src/scheduler.ts` in `ALL_SCRAPERS` aufnehmen
4. Bei Bedarf Tabellen in `src/db/schema.ts` ergänzen

### Migrationen
Bei Änderungen an normalisierten Tabellen (neue Spalten, Umbau) als Skript in `scripts/` anlegen und dokumentieren. Einmalige Migrationen (`data`-JSON → flache Spalten) sind bereits ausgeführt: countries, mu, item_prices, users, battles.

### Wichtige Entscheidungen & Pattern
- **Kein `data`-JSON** in normalisierten Tabellen – alle Felder flach ausgelegt
- **Batch-API-Calls** in Chunks von 50 via `Promise.all`
- **`company.getCompanies`** liefert nur String-IDs – immer `getById` nachladen
- **Stale Companies** hart löschen (erst `company_workers`, dann `companies`)
- **Donations/Parties** erfordern `countryId`-Filter – Iteration über alle Länder
- **Item Prices** column-per-item (ein Row pro Scrape) statt row-per-item
- **Zeitstempel** sind immer UTC (`new Date().toISOString()`)

## MCP-Server

Der MCP-Server (`src/mcp-server.ts`) macht die Datenbank über das Model Context Protocol für KI-Assistenten zugänglich.

### Setup (opencode)

In `~/.config/opencode/mcp.json`:

```json
{
  "mcpServers": {
    "warera": {
      "command": "tsx",
      "args": ["/home/dario/Documents/WareraDataScraper/src/mcp-server.ts"],
      "env": {
        "WARERA_API_KEY": "wae_6497d6c62c9723db5a72baeb34e5cfc81f9b9887c425f4a41b064eb9b1aef96c",
        "SCRAPER_DATA_DIR": "/home/dario/Documents/WareraDataScraper/data"
      }
    }
  }
}
```

### Verfügbare Tools

| Tool | Beschreibung |
|------|-------------|
| `get_tables` | Alle Tabellen + CREATE TABLE SQL |
| `run_query` | Beliebige SELECT/With/PRAGMA-Query (read-only) |
| `get_active_battles` | Aktive Schlachten |
| `get_country` | Land per ID oder Name |
| `get_user` | Benutzer per ID oder Username |
| `get_mu` | Militäreinheit per ID |
| `get_top_ranking` | Top-N Einträge nach Spalte (countries/users/military_units) |
| `get_latest_prices` | Aktuelle Item-Preise |
| `get_scraper_status` | Letzter Lauf jedes Scrapers |
| `get_entity_history` | Zeitverlauf eines Users oder Lands |
| `trigger_scrape` | Scraper manuell ausführen |

### Manuell testen

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | npm run mcp
```
