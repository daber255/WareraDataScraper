#!/usr/bin/env node
import { loadConfig } from './config.js';
import { runOnce, startScheduler } from './scheduler.js';

const args = process.argv.slice(2);
const isOnce = args.includes('--once');
const isAll = args.includes('--all');

const cfg = loadConfig();

if (isOnce) {
  runOnce(cfg, isAll);
} else {
  startScheduler(cfg);
}
