import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aiAvailability } from './ai.ts';
import { CONFIG_PATH, rootCandidates, type ResolvedConfig } from './config.ts';
import type { Store } from './store.ts';
import type { Analysis, Inventory } from './types.ts';

/** The desktop app passes the bundled template's path; the npm package finds it next to the code. */
const templatePath = (): string => process.env.KLOSTI_TEMPLATE ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'template.html');

export interface PagePayload extends Record<string, unknown> {
  review: { done: number; total: number; lastAt: string | null };
}

export function payload(store: Store, analysis: Analysis, config: ResolvedConfig): PagePayload {
  const inventory = store.inventory() as Inventory;
  const judgements = store.judgements();
  const fresh = (group: 'skills' | 'rules' | 'instructions', key: string): boolean => !!judgements[group][key] && !judgements[group][key]?.carriedOver;
  const wanted = <T extends { agent: string }>(list: T[]): T[] => list.filter(x => !config.agents.length || config.agents.includes(x.agent));
  const contexts = wanted(analysis.contexts), stacks = wanted(analysis.stacks), istacks = wanted(analysis.instructionStacks);
  const done = contexts.filter(c => fresh('skills', c.key)).length + stacks.filter(s => fresh('rules', s.key)).length + istacks.filter(s => fresh('instructions', s.key)).length;
  const dates = [...Object.values(judgements.skills), ...Object.values(judgements.rules), ...Object.values(judgements.instructions)].map(v => v.at).sort();
  return {
    things: analysis.things, projects: analysis.projects, findings: analysis.findings, budgets: analysis.budgets,
    review: { done, total: contexts.length + stacks.length + istacks.length, lastAt: dates.at(-1) ?? null },
    ai: aiAvailability(),
    settings: { agents: config.agents, roots: config.codeRoots, candidates: rootCandidates(config), agentRoots: config.agentRoots, configFile: CONFIG_PATH },
    history: inventory.history ?? [], actions: store.actions(), plugins: inventory.plugins ?? [], memories: inventory.memories ?? [],
    scannedAt: inventory.scannedAt, baselineAt: inventory.baselineAt ?? inventory.scannedAt, roots: inventory.roots ?? [], excluded: inventory.excluded ?? [], ignored: inventory.ignored ?? [], limits: inventory.limits ?? [], errors: inventory.errors ?? [],
  };
}

/** The whole app is one HTML file with the data embedded, so it also works opened straight from disk. */
export function renderPage(data: Record<string, unknown>, api: { token: string } | null = null): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const script = api ? `<script>window.KLOSTI_API=${JSON.stringify(api)};</script>` : '';
  return readFileSync(templatePath(), 'utf8').replace('</head>', `${script}</head>`).replace('__DATA__', () => json);
}
