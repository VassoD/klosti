#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { analyze } from './analyze.ts';
import { resolveConfig } from './config.ts';
import { payload, renderPage } from './page.ts';
import { planReview, runReview } from './review.ts';
import { scan } from './scan.ts';
import { KlostiServer } from './server.ts';
import { Store } from './store.ts';
import type { Inventory } from './types.ts';

const DEFAULT_PORT = 4711;
const HELP = `klosti: see every rule, skill, hook and MCP server your coding agents use.

Usage
  klosti                 Scan, then open the app in your browser
  klosti scan            Scan and print a summary
  klosti review          AI review of overlaps and contradictions (uses Claude)
  klosti build -o FILE   Write a standalone HTML page
  klosti serve           Run the app without opening a browser

Options
  --root DIR      Scan this folder for projects (repeatable). Default: common code folders in your home
  --data DIR      Where the app keeps its data
  --port N        Port for the app (default ${DEFAULT_PORT})
  --dry-run       review: list what would be reviewed, without calling Claude
  --force         review: review everything again
  --no-watch      serve: do not rescan when skill or plugin folders change
  --notify        scan: show a desktop notification when something was added, changed or removed
  -o, --out FILE  build: output file
  -h, --help      Show this help`;

const NOTIFY_NAME_LIMIT = 3;

/** macOS only for now; the desktop app will handle notifications natively. */
function notify(changes: { added: { name: string }[]; changed: { name: string }[]; removed: { name: string }[] }): void {
  if (platform() !== 'darwin') return;
  const describe = (label: string, items: { name: string }[]): string => {
    const names = items.map(i => i.name);
    return `${names.length} ${label}: ${names.slice(0, NOTIFY_NAME_LIMIT).join(', ')}${names.length > NOTIFY_NAME_LIMIT ? ` +${names.length - NOTIFY_NAME_LIMIT}` : ''}`;
  };
  const parts = [describe('new', changes.added), describe('updated', changes.changed), describe('removed', changes.removed)].filter(p => !p.startsWith('0 '));
  // Text goes in as arguments so names never need AppleScript escaping.
  const script = 'on run argv\ndisplay notification (item 1 of argv) with title "Klosti" subtitle "Your agent setup changed"\nend run';
  spawn('osascript', ['-e', script, parts.join(' · ')], { stdio: 'ignore', detached: true }).unref();
}

function openBrowser(url: string): void {
  const command = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform() === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(command, args, { stdio: 'ignore', detached: true }).unref();
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: 'string', multiple: true }, data: { type: 'string' }, port: { type: 'string' },
      'dry-run': { type: 'boolean' }, force: { type: 'boolean' }, 'no-watch': { type: 'boolean' },
      out: { type: 'string', short: 'o' }, help: { type: 'boolean', short: 'h' }, notify: { type: 'boolean' },
    },
  });
  if (values.help) { console.log(HELP); return; }
  const command = positionals[0] ?? 'open';
  const config = resolveConfig({ roots: values.root, dataDir: values.data });
  const store = new Store(config.dataDir);
  const port = values.port ? Number(values.port) : DEFAULT_PORT;

  const doScan = (): Inventory => {
    const { inventory, changes } = scan(config, store.inventory());
    store.saveInventory(inventory);
    const counted = (n: number, word: string): string => `${n} ${word}`;
    console.log(`Scanned ${inventory.roots.length} folders: ${counted(inventory.primaryFileCount, 'rule files')}, ${counted(inventory.skillCount, 'skills')}, ${counted(inventory.extras.hooks.length, 'hooks')}, ${counted(inventory.extras.mcp.length, 'MCP servers')}.`);
    const delta = changes.added.length + changes.changed.length + changes.removed.length;
    if (delta) {
      console.log(`Since last scan: ${changes.added.length} added, ${changes.changed.length} changed, ${changes.removed.length} removed.`);
      if (values.notify) notify(changes);
    }
    if (inventory.errors.length) console.log(`${inventory.errors.length} folders could not be read.`);
    return inventory;
  };

  switch (command) {
    case 'scan': {
      const inventory = doScan();
      const analysis = analyze(inventory, store.judgements());
      const high = analysis.findings.filter(f => f.severity === 'high').length;
      console.log(`${analysis.findings.length} findings, ${high} need a decision. Data: ${config.dataDir}`);
      return;
    }
    case 'review': {
      if (!store.inventory().files) doScan();
      const plan = planReview(analyze(store.inventory() as Inventory, store.judgements()), store, values.force ?? false);
      if (values['dry-run'] || !plan.jobs.length) { console.log(plan.jobs.length ? `Would review ${plan.jobs.length} places:\n  ${plan.pending.join('\n  ')}` : 'Everything is already reviewed.'); return; }
      console.log(`Reviewing ${plan.jobs.length} places with Claude...`);
      const result = await runReview(plan, store, (done, total) => process.stdout.write(`\r  ${done}/${total}`));
      console.log(`\nReviewed ${result.reviewed}.${result.costUsd ? ` About $${result.costUsd.toFixed(2)} at list price.` : ''}`);
      result.failed.forEach(f => console.log(`  failed: ${f}`));
      return;
    }
    case 'build': {
      const inventory = store.inventory().files ? store.inventory() as Inventory : doScan();
      const out = resolve(values.out ?? 'klosti.html');
      writeFileSync(out, renderPage(payload(store, analyze(inventory, store.judgements()))));
      console.log(`Wrote ${out}`);
      return;
    }
    case 'serve':
    case 'open': {
      doScan();
      const server = new KlostiServer(store, config, {
        port, watch: !values['no-watch'],
        onChange: s => console.log(JSON.stringify({ at: new Date().toISOString(), event: 'changed', ...s })),
      });
      const url = await server.start();
      console.log(`Klosti running at ${url}  (Ctrl+C to stop)`);
      if (command === 'open') openBrowser(url);
      const stop = (): void => { void server.stop().then(() => process.exit(0)); };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return;
    }
    default:
      console.error(`Unknown command "${command}".\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
