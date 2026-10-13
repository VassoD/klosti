import { z } from 'zod';
import { normalize } from './actions.ts';
import { AI_MODEL, askClaude } from './ai.ts';
import { analyze, short } from './analyze.ts';
import { nowIso } from './scan.ts';
import type { Store } from './store.ts';
import type { Agent, Analysis, InstructionStack, Judgements, ProjectRef, RuleStack, SkillContext, Thing } from './types.ts';

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

/** How each agent combines rule files, per its docs, so the review judges each setup on its own terms. */
const RULE_ORDER: Partial<Record<Agent, string>> = {
  Claude: 'Claude Code concatenates these from broadest to most specific. Its docs say that when two instructions contradict, Claude may pick one arbitrarily.',
  Codex: 'Codex joins these from the global file down to the project. Files closer to the working directory override earlier guidance because they appear later.',
  Vibe: 'Mistral Vibe loads ~/.vibe/AGENTS.md and the AGENTS.md files from the working directory up to the trust root. Its docs say closer directories override more distant ones.',
};

function rulePrompt(stack: RuleStack, byId: Map<string, Thing>, projects: Map<string, ProjectRef>): string {
  const parts = stack.rules.map((id, n) => {
    const t = byId.get(id)!;
    return `=== File ${n + 1}: ${short(t.paths[0] ?? '')} (${t.global ? 'global' : 'project'}) ===\n${t.body.slice(0, RULE_FILE_CHARS)}`;
  });
  const order = RULE_ORDER[stack.agent] ?? 'Its documentation does not say how these files are combined or which one wins.';
  return `These instruction files all load into the same ${stack.agent} session ${where(stack.project, projects)}, in this order. ${order}

${parts.join('\n\n')}

List genuine contradictions only: two instructions that cannot both be followed in the same situation. A project rule that is simply more specific, or a difference in emphasis, is not a contradiction. Use the file paths exactly as written in the headers.

For each give: title (under 8 words), files (the paths involved), quotes (the conflicting lines, each under 160 characters, with its file), explanation (one or two sentences), happens (what ${stack.agent} will most likely do), advice (one concrete sentence). Return an empty list if there are none. ${STYLE}`;
}

const DIGEST_SKILL_CHARS = 24000;
const DIGEST_BATCH_CHARS = 60000;
const MAX_DIGEST_LINES = 10;
const QUOTE_CHARS = 160;
/** Rough size of one skill's digest in a prompt, for estimates made before the digests exist. */
const ESTIMATED_DIGEST_CHARS = 500;

export const DigestSchema = z.object({
  skills: z.array(z.object({ ref: z.string(), instructions: z.array(z.string()) })),
});

function digestPrompt(batch: Thing[]): string {
  const parts = batch.map((t, n) => `=== Skill s${n + 1}: ${t.name} ===\n${t.body.slice(0, DIGEST_SKILL_CHARS)}`);
  return `Below are agent skills (the body of each SKILL.md). A skill's text is added to the session when the agent uses it.

${parts.join('\n\n')}

For each skill, list the behaviour instructions that a user's own rules could contradict: how to work, plan, commit, branch, test, review, ask for confirmation, format output, which tools or commands to use or avoid, and what never to do. Skip domain knowledge, examples, templates, reference material and explanations.

Copy each instruction exactly as it appears in the skill, from a single line, under ${QUOTE_CHARS} characters. When a line is longer, copy an exact part of it. At most ${MAX_DIGEST_LINES} per skill, most consequential first. Use ref exactly as given (s1, s2, ...). Return an empty list for a skill with no such instructions.`;
}

/** Keeps only instructions that really are in the skill, so a later "Delete this line" can find them. */
export function verbatim(body: string, instructions: string[]): string[] {
  const lines = body.split('\n').map(normalize);
  return [...new Set(instructions.map(i => i.trim()).filter(i => {
    const wanted = normalize(i);
    return wanted.length > 0 && i.length <= QUOTE_CHARS * 2 && lines.some(line => line.includes(wanted));
  }))].slice(0, MAX_DIGEST_LINES);
}

function instructionPrompt(stack: InstructionStack, byId: Map<string, Thing>, projects: Map<string, ProjectRef>, digests: Judgements['digests']): string | null {
  const focus = new Set(stack.focus);
  const tag = (id: string): string => (focus.has(id) ? ' [PROJECT]' : '');
  const skills = stack.skills.map(id => byId.get(id)!).filter(t => digests[t.sha]?.instructions.length);
  if (!skills.length) return null;
  const rules = stack.rules.map(id => {
    const t = byId.get(id)!;
    return `=== Rule file: ${short(t.paths[0] ?? '')} (${t.global ? 'global' : 'project'})${tag(id)} ===\n${t.body.slice(0, RULE_FILE_CHARS)}`;
  });
  const skillParts = skills.map(t => {
    const from = t.plugin ? `from the plugin ${t.plugin.split('@')[0]}, read-only` : t.global ? 'global' : 'project';
    return `=== Skill: ${t.name}, file ${short(t.paths[0] ?? '')} (${from})${tag(t.id)} ===\n${digests[t.sha]!.instructions.map(i => `- ${i}`).join('\n')}`;
  });
  const focusLine = stack.focus.length ? ' Only report contradictions that involve at least one file marked [PROJECT]. The others are reviewed separately.' : '';
  return `These all load into the same ${stack.agent} session ${where(stack.project, projects)}. Rule files load at the start of every session. A skill's instructions load only when ${stack.agent} uses that skill: it picks skills by their description, or the user calls one. For each skill, only its behaviour instructions are listed, quoted exactly.

${[...rules, ...skillParts].join('\n\n')}

List genuine contradictions that involve at least one skill: a skill instruction that cannot be followed together with a rule, or with another skill's instruction that applies in the same situation. Contradictions between two rule files are checked separately, so do not report those.${focusLine} A skill that is simply more specific about its own task, or a difference in emphasis, is not a contradiction.

For each give: title (under 8 words), files (the paths involved, exactly as written in the headers), quotes (the conflicting lines copied exactly, each under ${QUOTE_CHARS} characters, with its file), explanation (one or two sentences), happens (what ${stack.agent} will most likely do when the skill is in use), advice (one concrete sentence; prefer editing the user's own file over a read-only plugin skill, because plugin files are replaced on update). Return an empty list if there are none. ${STYLE}`;
}

type Cache = Judgements;

interface Job {
  label: string;
  /** Skill digests run first, because the instruction checks read them. */
  phase: 1 | 2;
  /** Prompt size, measured, or estimated when it depends on digests that do not exist yet. */
  inputChars: number;
  run: (store: Store) => Promise<{ costUsd: number; save: (cache: Cache) => void }>;
}

export interface ReviewPlan { pending: string[]; jobs: Job[]; inputChars: number }

const entry = <T extends object>(value: T): T & { at: string; model: string } => ({ ...value, at: nowIso(), model: AI_MODEL });

/** What still needs an AI review: places never reviewed, or carried over after a change made from the app. */
export function planReview(analysis: Analysis, store: Store, force = false, agents: string[] = []): ReviewPlan {
  const wanted = (agent: string): boolean => !agents.length || agents.includes(agent);
  const cache = store.judgements();
  const byId = new Map(analysis.things.map(t => [t.id, t]));
  const projects = new Map(analysis.projects.map(p => [p.id, p]));
  const label = (kind: string, agent: string, project: string | null): string => `${kind}:${agent}:${project ? projects.get(project)?.name ?? project : 'global'}`;
  const jobs: Job[] = [];
  // Clones of one repo share cache keys, so each key is reviewed once.
  const planned = new Set<string>();
  const stale = (cached: { carriedOver?: boolean } | undefined, key: string): boolean => {
    if (planned.has(key)) return false;
    planned.add(key);
    return force || !cached || !!cached.carriedOver;
  };
  for (const ctx of analysis.contexts.filter(c => wanted(c.agent))) {
    if (!stale(cache.skills[ctx.key], `skills:${ctx.key}`)) continue;
    const prompt = skillPrompt(ctx, byId, projects);
    jobs.push({ label: label('skills', ctx.agent, ctx.project), phase: 2, inputChars: prompt.length, run: async () => {
      const { value, costUsd } = await askClaude(prompt, SkillGroupsSchema);
      return { costUsd, save: c => { c.skills[ctx.key] = entry(value); } };
    } });
  }
  for (const stack of analysis.stacks.filter(s => wanted(s.agent))) {
    if (!stale(cache.rules[stack.key], `rules:${stack.key}`)) continue;
    const prompt = rulePrompt(stack, byId, projects);
    jobs.push({ label: label('rules', stack.agent, stack.project), phase: 2, inputChars: prompt.length, run: async () => {
      const { value, costUsd } = await askClaude(prompt, RuleConflictsSchema);
      return { costUsd, save: c => { c.rules[stack.key] = entry(value); } };
    } });
  }

  const istacks = analysis.instructionStacks.filter(s => wanted(s.agent) && stale(cache.instructions[s.key], `instructions:${s.key}`));
  const needed = new Map<string, Thing>();
  for (const s of istacks) for (const id of s.skills) { const t = byId.get(id)!; if (force || !cache.digests[t.sha]) needed.set(t.sha, t); }
  const batches: Thing[][] = [];
  for (const t of [...needed.values()].sort((a, b) => a.sha.localeCompare(b.sha))) {
    const last = batches.at(-1);
    const size = (last ?? []).reduce((n, x) => n + Math.min(x.body.length, DIGEST_SKILL_CHARS), 0);
    if (last && size + Math.min(t.body.length, DIGEST_SKILL_CHARS) <= DIGEST_BATCH_CHARS) last.push(t);
    else batches.push([t]);
  }
  batches.forEach((batch, n) => {
    const prompt = digestPrompt(batch);
    jobs.push({ label: `skill instructions ${n + 1}/${batches.length}`, phase: 1, inputChars: prompt.length, run: async () => {
      const { value, costUsd } = await askClaude(prompt, DigestSchema);
      const byRef = new Map(value.skills.map(s => [s.ref, s.instructions]));
      return { costUsd, save: c => batch.forEach((t, i) => { c.digests[t.sha] = entry({ instructions: verbatim(t.body, byRef.get(`s${i + 1}`) ?? []) }); }) };
    } });
  });
  for (const stack of istacks) {
    const known = instructionPrompt(stack, byId, projects, cache.digests);
    const estimate = stack.rules.reduce((n, id) => n + Math.min(byId.get(id)!.body.length, RULE_FILE_CHARS), 0) + stack.skills.length * ESTIMATED_DIGEST_CHARS;
    const everyDigest = stack.skills.every(id => cache.digests[byId.get(id)!.sha]);
    jobs.push({ label: label('skills vs rules', stack.agent, stack.project), phase: 2, inputChars: everyDigest && !force ? known?.length ?? 0 : estimate, run: async current => {
      // Digests from phase 1 are in the store by now, unless that call failed.
      const digests = current.judgements().digests;
      if (stack.skills.some(id => !digests[byId.get(id)!.sha])) throw new Error('Some skills could not be read, so this place was not checked. Run the review again.');
      const prompt = instructionPrompt(stack, byId, projects, digests);
      if (!prompt) return { costUsd: 0, save: c => { c.instructions[stack.key] = entry({ conflicts: [] }); } };
      const { value, costUsd } = await askClaude(prompt, RuleConflictsSchema);
      return { costUsd, save: c => { c.instructions[stack.key] = entry(value); } };
    } });
  }
  jobs.sort((a, b) => a.phase - b.phase);
  return { pending: jobs.map(j => j.label), jobs, inputChars: jobs.reduce((n, j) => n + j.inputChars, 0) };
}

export interface ReviewResult { reviewed: number; failed: string[]; costUsd: number }

/** Runs the plan a few calls at a time, phase by phase, and saves each answer as soon as it arrives. */
export async function runReview(plan: ReviewPlan, store: Store, onProgress?: (done: number, total: number) => void): Promise<ReviewResult> {
  const failed: string[] = [];
  let costUsd = 0, done = 0;
  for (const phase of [1, 2] as const) {
    const queue = plan.jobs.filter(j => j.phase === phase);
    const worker = async (): Promise<void> => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        try {
          const answer = await job.run(store);
          costUsd += answer.costUsd;
          const cache = store.judgements();
          answer.save(cache);
          store.saveJudgements(cache);
        } catch (error) {
          failed.push(`${job.label}: ${error instanceof Error ? error.message : String(error)}`);
        }
        done += 1;
        onProgress?.(done, plan.jobs.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL_CALLS, queue.length) }, worker));
  }
  return { reviewed: plan.jobs.length - failed.length, failed, costUsd: Math.round(costUsd * 10000) / 10000 };
}

export function analyzeFromStore(store: Store): Analysis {
  const inventory = store.inventory();
  if (!inventory.files) throw new Error('No scan yet. Run a scan first.');
  return analyze(inventory as Parameters<typeof analyze>[0], store.judgements());
}
