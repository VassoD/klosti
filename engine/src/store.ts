import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionEntry, Inventory, Judgements } from './types.ts';
import type { UsageCache } from './usage.ts';

const ACTIONS_LIMIT = 300;

/** Everything the app remembers lives in one data folder, never next to the user's code. */
export class Store {
  readonly inventoryFile: string;
  readonly judgementsFile: string;
  readonly actionsFile: string;
  readonly backupsDir: string;
  readonly usageFile: string;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.inventoryFile = join(dir, 'inventory.json');
    this.judgementsFile = join(dir, 'judgements.json');
    this.actionsFile = join(dir, 'actions.json');
    this.backupsDir = join(dir, 'backups');
    this.usageFile = join(dir, 'usage.json');
  }

  private read<T>(file: string, fallback: T): T {
    if (!existsSync(file)) return fallback;
    try { return JSON.parse(readFileSync(file, 'utf8')) as T; }
    catch { return fallback; }
  }

  /** Write to a temp file first so a crash never leaves half a file behind. */
  private write(file: string, value: unknown): void {
    const temp = `${file}.tmp`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temp, file);
  }

  inventory(): Partial<Inventory> { return this.read<Partial<Inventory>>(this.inventoryFile, {}); }
  saveInventory(inventory: Inventory): void { this.write(this.inventoryFile, inventory); }

  judgements(): Judgements {
    const cache = this.read<Partial<Judgements>>(this.judgementsFile, {});
    return { skills: cache.skills ?? {}, rules: cache.rules ?? {}, instructions: cache.instructions ?? {}, digests: cache.digests ?? {} };
  }
  saveJudgements(judgements: Judgements): void { this.write(this.judgementsFile, judgements); }

  usage(): UsageCache { return this.read<UsageCache>(this.usageFile, { files: {} }); }
  saveUsage(usage: UsageCache): void { this.write(this.usageFile, usage); }

  actions(): ActionEntry[] { return this.read<ActionEntry[]>(this.actionsFile, []); }
  logAction(entry: ActionEntry): void { this.write(this.actionsFile, [...this.actions(), entry].slice(-ACTIONS_LIMIT)); }
}
