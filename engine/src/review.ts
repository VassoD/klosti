import { z } from 'zod';
import { AI_MODEL, askClaude } from './ai.ts';
import { analyze, short } from './analyze.ts';
import { nowIso } from './scan.ts';
import type { Store } from './store.ts';
import type { Analysis, ProjectRef, RuleStack, SkillContext, Thing } from './types.ts';

const PARALLEL_CALLS = 3;
const DESCRIPTION_CHARS = 400;
const RULE_FILE_CHARS = 30000;
const STYLE = 'Write for a busy developer in plain English. Short sentences. Never use em dashes. Do not invent facts that are not in the text.';

export const SkillGroupsSchema = z.object({
  groups: z.array(z.object({
    verdict: z.enum(['duplicate', 'overlap', 'conflict']),
    ids: z.array(z.string()),
    title: z.string(),
    summary: z.string(),
    happens: z.string(),
    likelyPick: z.string().optional(),
    advice: z.string(),
  })),
});

export const RuleConflictsSchema = z.object({
  conflicts: z.array(z.object({
    title: z.string(),
    files: z.array(z.string()),
    quotes: z.array(z.object({ file: z.string(), text: z.string() })),
    explanation: z.string(),
    happens: z.string(),
    advice: z.string(),
  })),
});

const where = (project: string | null, projects: Map<string, ProjectRef>): string => (project ? `in the project ${projects.get(project)?.name ?? project}` : 'everywhere (no project-specific skills)');

function skillPrompt(ctx: SkillContext, byId: Map<string, Thing>, projects: Map<string, ProjectRef>): string {
  const lines = ctx.ids.map(id => {
    const t = byId.get(id)!;
    const origin = t.origin ?? (t.global ? t.source ?? 'global' : 'project skill');
    const tag = ctx.focus.includes(id) ? ' [PROJECT]' : '';
    return `${id} | ${t.name}${tag} | ${t.kind} from ${origin} | ${t.description.slice(0, DESCRIPTION_CHARS).replace(/\n/g, ' ')}`;
  });
  const focus = ctx.focus.length ? 'Only report groups that include at least one skill marked [PROJECT]. Groups made only of global skills are reviewed separately.' : '';
  return `These are all the skills and commands ${ctx.agent} can use ${where(ctx.project, projects)}. Each line is: id | name | type and origin | description.

${lines.join('\n')}

Find groups of two or more that a user should know about:
- duplicate: they do the same job.
- overlap: they would trigger in substantially the same situations, so ${ctx.agent} could pick either.
- conflict: they give contradicting instructions for the same situation.
Ignore skills that only share a broad domain but have clearly distinct triggers. Ignore skills from the same plugin unless they truly duplicate each other. ${focus}

For each group give: verdict, ids (exactly as listed), title (under 8 words, plain), summary (one sentence on what they have in common), happens (one or two sentences on what ${ctx.agent} will most likely do and why, judged from the descriptions; say plainly that there is no guaranteed tie-break), likelyPick (the id it would most likely load, or empty), advice (one concrete sentence: which to keep, remove, rename or mark manual-only). Return an empty list if nothing qualifies. ${STYLE}`;
}

function rulePrompt(stack: RuleStack, byId: Map<string, Thing>, projects: Map<string, ProjectRef>): string {
  const parts = stack.rules.map((id, n) => {
    const t = byId.get(id)!;
    return `=== File ${n + 1}: ${short(t.paths[0] ?? '')} (${t.global ? 'global' : 'project'}) ===\n${t.body.slice(0, RULE_FILE_CHARS)}`;
  });
  const order = stack.agent === 'Claude'
    ? 'Claude Code concatenates these from broadest to most specific. Its docs say that when two instructions contradict, Claude may pick one arbitrarily.'
    : 'Codex joins these from the global file down to the project. Files closer to the working directory override earlier guidance because they appear later.';
  return `These instruction files all load into the same ${stack.agent} session ${where(stack.project, projects)}, in this order. ${order}

${parts.join('\n\n')}

List genuine contradictions only: two instructions that cannot both be followed in the same situation. A project rule that is simply more specific, or a difference in emphasis, is not a contradiction. Use the file paths exactly as written in the headers.

For each give: title (under 8 words), files (the paths involved), quotes (the conflicting lines, each under 160 characters, with its file), explanation (one or two sentences), happens (what ${stack.agent} will most likely do), advice (one concrete sentence). Return an empty list if there are none. ${STYLE}`;
}

interface Job {
  kind: 'skills' | 'rules';
  key: string;
  label: string;
  run: () => Promise<{ value: unknown; costUsd: number }>;
}

export interface ReviewPlan { pending: string[]; jobs: Job[] }

/** What still needs an AI review: places never reviewed, or carried over after a change made from the app. */
export function planReview(analysis: Analysis, store: Store, force = false): ReviewPlan {
  const cache = store.judgements();
  const byId = new Map(analysis.things.map(t => [t.id, t]));
  const projects = new Map(analysis.projects.map(p => [p.id, p]));
  const label = (kind: string, agent: string, project: string | null): string => `${kind}:${agent}:${project ? projects.get(project)?.name ?? project : 'global'}`;
  const jobs = new Map<string, Job>();
  for (const ctx of analysis.contexts) {
    const cached = cache.skills[ctx.key];
    if (force || !cached || cached.carriedOver) jobs.set(`skills:${ctx.key}`, { kind: 'skills', key: ctx.key, label: label('skills', ctx.agent, ctx.project), run: () => askClaude(skillPrompt(ctx, byId, projects), SkillGroupsSchema) });
  }
  for (const stack of analysis.stacks) {
    const cached = cache.rules[stack.key];
    if (force || !cached || cached.carriedOver) jobs.set(`rules:${stack.key}`, { kind: 'rules', key: stack.key, label: label('rules', stack.agent, stack.project), run: () => askClaude(rulePrompt(stack, byId, projects), RuleConflictsSchema) });
  }
  return { pending: [...jobs.values()].map(j => j.label), jobs: [...jobs.values()] };
}

export interface ReviewResult { reviewed: number; failed: string[]; costUsd: number }

/** Runs the plan a few calls at a time and saves each answer as soon as it arrives. */
export async function runReview(plan: ReviewPlan, store: Store, onProgress?: (done: number, total: number) => void): Promise<ReviewResult> {
  const failed: string[] = [];
  let costUsd = 0, done = 0;
  const queue = [...plan.jobs];
  const worker = async (): Promise<void> => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      try {
        const answer = await job.run();
        costUsd += answer.costUsd;
        const cache = store.judgements();
        const entry = { ...(answer.value as object), at: nowIso(), model: AI_MODEL };
        if (job.kind === 'skills') cache.skills[job.key] = entry as typeof cache.skills[string];
        else cache.rules[job.key] = entry as typeof cache.rules[string];
        store.saveJudgements(cache);
      } catch (error) {
        failed.push(`${job.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
      done += 1;
      onProgress?.(done, plan.jobs.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_CALLS, plan.jobs.length) }, worker));
  return { reviewed: plan.jobs.length - failed.length, failed, costUsd: Math.round(costUsd * 10000) / 10000 };
}

export function analyzeFromStore(store: Store): Analysis {
  const inventory = store.inventory();
  if (!inventory.files) throw new Error('No scan yet. Run a scan first.');
  return analyze(inventory as Parameters<typeof analyze>[0], store.judgements());
}
