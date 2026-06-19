import 'dotenv/config';
import Database from 'better-sqlite3';
import { createAPIClient } from '@wareraprojects/api';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.js';
import { ALL_SCRAPERS } from './scheduler.js';
import type { ScraperDefinition } from './scrapers/base.js';

const cfg = loadConfig();

const db = new Database(cfg.dbPath);
db.pragma('journal_mode = WAL');

const apiClient = createAPIClient({ apiKey: cfg.apiKey, rateLimit: 500 });

function isReadOnlyQuery(sql: string): boolean {
  const trimmed = sql.trimStart();
  const upper = trimmed.toUpperCase();
  if (upper.startsWith('SELECT') || upper.startsWith('WITH') || upper.startsWith('PRAGMA')) {
    const forbidden = /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|DETACH|REINDEX|VACUUM|EXPLAIN\s+INSERT)/i;
    return !forbidden.test(trimmed);
  }
  return false;
}

function jsonRows(rows: unknown[]): string {
  return JSON.stringify(rows, null, 2);
}

const TOOLS = [
  {
    name: 'get_tables',
    description: 'List all database tables with their CREATE TABLE SQL definitions',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'run_query',
    description: 'Execute a read-only SELECT / WITH / PRAGMA query. Blocks destructive statements.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'SELECT query to execute' },
      },
      required: ['sql'],
    },
  },
  {
    name: 'get_active_battles',
    description: 'Get currently active battles with attacker/defender info',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_country',
    description: 'Get country details by ID or name',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Country ID (e.g. "64e8...")' },
        name: { type: 'string', description: 'Country name (e.g. "Germany")' },
      },
    },
  },
  {
    name: 'get_user',
    description: 'Get user details by ID or username',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'User ID' },
        username: { type: 'string', description: 'Username' },
      },
    },
  },
  {
    name: 'get_mu',
    description: 'Get military unit by ID',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Military unit ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_top_ranking',
    description: 'Get top entries from a ranking type (countries, users, or MUs)',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Ranking table: "countries", "users", or "military_units"',
          enum: ['countries', 'users', 'military_units'],
        },
        order_by: {
          type: 'string',
          description: 'Column to order by (e.g. "wealth", "damages", "weekly_damages", "level")',
          default: 'wealth',
        },
        limit: { type: 'number', description: 'Number of results', default: 10 },
        ascending: { type: 'boolean', description: 'Sort ascending instead of descending', default: false },
      },
      required: ['type'],
    },
  },
  {
    name: 'get_latest_prices',
    description: 'Get the latest item prices snapshot',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_scraper_status',
    description: 'Get last scrape run for each scraper (status, items fetched, errors)',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_entity_history',
    description: 'Get time-series history for a user or country',
    inputSchema: {
      type: 'object',
      properties: {
        entity: {
          type: 'string',
          description: 'Entity type: "user" or "country"',
          enum: ['user', 'country'],
        },
        id: { type: 'string', description: 'Entity ID' },
        days: { type: 'number', description: 'Number of days to look back', default: 7 },
        limit: { type: 'number', description: 'Max rows', default: 100 },
      },
      required: ['entity', 'id'],
    },
  },
  {
    name: 'trigger_scrape',
    description: 'Trigger a scraper to run immediately',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Scraper name to run',
          enum: ALL_SCRAPERS.map(s => s.name),
        },
      },
      required: ['name'],
    },
  },
];

const server = new Server(
  { name: 'warera-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'get_tables': {
        const rows = db.prepare(
          `SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name`,
        ).all();
        return { content: [{ type: 'text', text: jsonRows(rows) }] };
      }

      case 'run_query': {
        const sql = String(args?.sql ?? '');
        if (!isReadOnlyQuery(sql)) {
          return {
            content: [{ type: 'text', text: 'Only SELECT / WITH / PRAGMA queries are allowed' }],
            isError: true,
          };
        }
        const rows = db.prepare(sql).all();
        return { content: [{ type: 'text', text: jsonRows(rows) }] };
      }

      case 'get_active_battles': {
        const battles = db.prepare(
          `SELECT * FROM battles WHERE is_active = 1 ORDER BY created_at DESC`,
        ).all();
        return { content: [{ type: 'text', text: jsonRows(battles) }] };
      }

      case 'get_country': {
        const { id, name } = args ?? {};
        let country;
        if (id) {
          country = db.prepare(`SELECT * FROM countries WHERE id = ?`).get(id);
        } else if (name) {
          country = db.prepare(`SELECT * FROM countries WHERE name = ?`).get(name);
        } else {
          return { content: [{ type: 'text', text: 'Provide either id or name' }], isError: true };
        }
        if (!country) return { content: [{ type: 'text', text: 'Country not found' }], isError: true };
        return { content: [{ type: 'text', text: jsonRows([country]) }] };
      }

      case 'get_user': {
        const { id, username } = args ?? {};
        let user;
        if (id) {
          user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
        } else if (username) {
          user = db.prepare(`SELECT * FROM users WHERE username = ?`).get(username);
        } else {
          return { content: [{ type: 'text', text: 'Provide either id or username' }], isError: true };
        }
        if (!user) return { content: [{ type: 'text', text: 'User not found' }], isError: true };
        return { content: [{ type: 'text', text: jsonRows([user]) }] };
      }

      case 'get_mu': {
        const mu = db.prepare(`SELECT * FROM military_units WHERE id = ?`).get(args?.id);
        if (!mu) return { content: [{ type: 'text', text: 'Military unit not found' }], isError: true };
        return { content: [{ type: 'text', text: jsonRows([mu]) }] };
      }

      case 'get_top_ranking': {
        const { type, order_by = 'wealth', limit = 10, ascending = false } = args ?? {};
        const validTables = ['countries', 'users', 'military_units'];
        if (!validTables.includes(type)) {
          return { content: [{ type: 'text', text: `Invalid type. Choose: ${validTables.join(', ')}` }], isError: true };
        }
        const safeOrderBy = (order_by as string).replace(/[^a-zA-Z_]/g, '');
        const direction = ascending ? 'ASC' : 'DESC';
        const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 200);
        const rows = db.prepare(
          `SELECT * FROM ${type} ORDER BY ${safeOrderBy} ${direction} LIMIT ?`,
        ).all(safeLimit);
        return { content: [{ type: 'text', text: jsonRows(rows) }] };
      }

      case 'get_latest_prices': {
        const prices = db.prepare(
          `SELECT * FROM item_prices ORDER BY fetched_at DESC LIMIT 1`,
        ).get();
        if (!prices) return { content: [{ type: 'text', text: 'No price data available' }], isError: true };
        return { content: [{ type: 'text', text: jsonRows([prices]) }] };
      }

      case 'get_scraper_status': {
        const rows = db.prepare(
          `SELECT s1.* FROM scrape_runs s1
           JOIN (SELECT scraper, MAX(started_at) AS max_started FROM scrape_runs GROUP BY scraper) s2
           ON s1.scraper = s2.scraper AND s1.started_at = s2.max_started
           ORDER BY s1.scraper`,
        ).all();
        return { content: [{ type: 'text', text: jsonRows(rows) }] };
      }

      case 'get_entity_history': {
        const { entity, id, days = 7, limit = 100 } = args ?? {};
        const table = entity === 'user' ? 'user_history' : 'country_history';
        const cutoff = new Date(Date.now() - Number(days) * 86400000).toISOString();
        const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
        const rows = db.prepare(
          `SELECT * FROM ${table} WHERE id = ? AND fetched_at >= ? ORDER BY fetched_at DESC LIMIT ?`,
        ).all(id, cutoff, safeLimit);
        if (rows.length === 0) return { content: [{ type: 'text', text: 'No history found' }], isError: true };
        return { content: [{ type: 'text', text: jsonRows(rows) }] };
      }

      case 'trigger_scrape': {
        const scraperName = args?.name as string;
        const def = ALL_SCRAPERS.find(s => s.name === scraperName);
        if (!def) {
          return { content: [{ type: 'text', text: `Unknown scraper: ${scraperName}` }], isError: true };
        }
        await def.execute(apiClient, db);
        return { content: [{ type: 'text', text: `Scraper "${scraperName}" completed successfully` }] };
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err: any) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
