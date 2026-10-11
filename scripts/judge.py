#!/usr/bin/env python3
"""AI review of overlapping skills and contradicting rules, using your local Claude Code in headless mode.

Results are cached in data/judgements.json by content hash, so only new or changed skill sets and rule stacks are sent.
The headless session loads no settings, plugins, hooks, MCP servers or tools."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import datetime
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from analyze import analyze, short  # noqa: E402

BASE = Path(__file__).resolve().parents[1]
INVENTORY = BASE / 'data/agent-rules-inventory.json'
CACHE = BASE / 'data/judgements.json'
MODEL = 'sonnet'
CALL_TIMEOUT_SECONDS = 300
PARALLEL_CALLS = 3
DESCRIPTION_CHARS = 400
RULE_FILE_CHARS = 30000
CLAUDE_FALLBACK = Path.home() / '.local/bin/claude'

SKILL_SCHEMA = {'type':'object', 'properties':{'groups':{'type':'array', 'items':{'type':'object', 'properties':{
    'verdict':{'type':'string', 'enum':['duplicate', 'overlap', 'conflict']},
    'ids':{'type':'array', 'items':{'type':'string'}},
    'title':{'type':'string'}, 'summary':{'type':'string'}, 'happens':{'type':'string'}, 'likelyPick':{'type':'string'}, 'advice':{'type':'string'}},
    'required':['verdict', 'ids', 'title', 'summary', 'happens', 'advice']}}}, 'required':['groups']}
RULE_SCHEMA = {'type':'object', 'properties':{'conflicts':{'type':'array', 'items':{'type':'object', 'properties':{
    'title':{'type':'string'}, 'files':{'type':'array', 'items':{'type':'string'}},
    'quotes':{'type':'array', 'items':{'type':'object', 'properties':{'file':{'type':'string'}, 'text':{'type':'string'}}, 'required':['file', 'text']}},
    'explanation':{'type':'string'}, 'happens':{'type':'string'}, 'advice':{'type':'string'}},
    'required':['title', 'files', 'quotes', 'explanation', 'happens', 'advice']}}}, 'required':['conflicts']}

STYLE = 'Write for a busy developer in plain English. Short sentences. Never use em dashes. Do not invent facts that are not in the text.'

def claude_binary():
    found = shutil.which('claude') or (str(CLAUDE_FALLBACK) if CLAUDE_FALLBACK.exists() else None)
    if not found: sys.exit('Claude Code CLI not found. Install it or add it to PATH.')
    return found

def ask(prompt, schema):
    with tempfile.TemporaryDirectory() as scratch:
        result = subprocess.run([claude_binary(), '-p', '--tools', '', '--disable-slash-commands', '--strict-mcp-config', '--no-session-persistence', '--setting-sources', '', '--model', MODEL, '--output-format', 'json', '--json-schema', json.dumps(schema)], input=prompt, capture_output=True, text=True, cwd=scratch, timeout=CALL_TIMEOUT_SECONDS)
    if result.returncode != 0: raise RuntimeError(result.stderr.strip() or result.stdout[:300])
    reply = json.loads(result.stdout)
    if reply.get('is_error') or 'structured_output' not in reply: raise RuntimeError(str(reply.get('result'))[:300])
    return reply['structured_output'], reply.get('total_cost_usd', 0)

def where(project, projects_by_id):
    return f"in the project {projects_by_id[project]['name']}" if project else 'everywhere (no project-specific skills)'

def skill_prompt(ctx, by_id, projects_by_id):
    lines = []
    for i in ctx['ids']:
        t = by_id[i]
        origin = t.get('origin') or ('project skill' if not t['global'] else t.get('source', 'global'))
        tag = ' [PROJECT]' if i in ctx['focus'] else ''
        lines.append(f"{i} | {t['name']}{tag} | {t['kind']} from {origin} | {t['description'][:DESCRIPTION_CHARS].replace(chr(10), ' ')}")
    focus = 'Only report groups that include at least one skill marked [PROJECT]. Groups made only of global skills are reviewed separately.' if ctx['focus'] else ''
    return f"""These are all the skills and commands {ctx['agent']} can use {where(ctx['project'], projects_by_id)}. Each line is: id | name | type and origin | description.

{chr(10).join(lines)}

Find groups of two or more that a user should know about:
- duplicate: they do the same job.
- overlap: they would trigger in substantially the same situations, so {ctx['agent']} could pick either.
- conflict: they give contradicting instructions for the same situation.
Ignore skills that only share a broad domain but have clearly distinct triggers. Ignore skills from the same plugin unless they truly duplicate each other. {focus}

For each group give: verdict, ids (exactly as listed), title (under 8 words, plain), summary (one sentence on what they have in common), happens (one or two sentences on what {ctx['agent']} will most likely do and why, judged from the descriptions; say plainly that there is no guaranteed tie-break), likelyPick (the id it would most likely load, or empty), advice (one concrete sentence: which to keep, remove, rename or mark manual-only). Return an empty list if nothing qualifies. {STYLE}"""

def rule_prompt(stack, by_id, projects_by_id):
    parts = []
    for n, i in enumerate(stack['rules'], 1):
        t = by_id[i]
        parts.append(f"=== File {n}: {short(t['paths'][0])} ({'global' if t['global'] else 'project'}) ===\n{t['body'][:RULE_FILE_CHARS]}")
    order = 'Claude Code concatenates these from broadest to most specific. Its docs say that when two instructions contradict, Claude may pick one arbitrarily.' if stack['agent'] == 'Claude' else 'Codex joins these from the global file down to the project. Files closer to the working directory override earlier guidance because they appear later.'
    return f"""These instruction files all load into the same {stack['agent']} session {where(stack['project'], projects_by_id)}, in this order. {order}

{chr(10).join(parts)}

List genuine contradictions only: two instructions that cannot both be followed in the same situation. A project rule that is simply more specific, or a difference in emphasis, is not a contradiction. Use the file paths exactly as written in the headers.

For each give: title (under 8 words), files (the paths involved), quotes (the conflicting lines, each under 160 characters, with its file), explanation (one or two sentences), happens (what {stack['agent']} will most likely do), advice (one concrete sentence). Return an empty list if there are none. {STYLE}"""

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--force', action='store_true', help='Review everything again, ignoring the cache')
    parser.add_argument('--dry-run', action='store_true', help='Only list what would be reviewed')
    args = parser.parse_args()
    data = json.loads(INVENTORY.read_text())
    cache = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    cache.setdefault('skills', {}); cache.setdefault('rules', {})
    result = analyze(data, cache)
    by_id = {t['id']: t for t in result['things']}
    projects_by_id = {p['id']: p for p in result['projects']}
    jobs = {}
    for ctx in result['contexts']:
        if args.force or ctx['key'] not in cache['skills'] or cache['skills'][ctx['key']].get('carriedOver'): jobs.setdefault(('skills', ctx['key']), (skill_prompt(ctx, by_id, projects_by_id), SKILL_SCHEMA, ctx))
    for stack in result['stacks']:
        if args.force or stack['key'] not in cache['rules'] or cache['rules'][stack['key']].get('carriedOver'): jobs.setdefault(('rules', stack['key']), (rule_prompt(stack, by_id, projects_by_id), RULE_SCHEMA, stack))
    if args.dry_run or not jobs:
        print(json.dumps({'pending':len(jobs), 'jobs':[f"{kind}:{meta['agent']}:{(meta['project'] or 'global').split('/')[-1]}" for (kind, _), (_, _, meta) in jobs.items()]}))
        return
    def run(item):
        (kind, key), (prompt, schema, meta) = item
        try: return kind, key, meta, *ask(prompt, schema), None
        except (RuntimeError, ValueError, subprocess.TimeoutExpired) as exc: return kind, key, meta, None, 0, str(exc)
    cost, failures = 0.0, []
    stamp = datetime.datetime.now().astimezone().isoformat(timespec='seconds')
    with ThreadPoolExecutor(PARALLEL_CALLS) as pool:
        for kind, key, meta, answer, spent, error in pool.map(run, jobs.items()):
            cost += spent or 0
            label = f"{kind}:{meta['agent']}:{(meta['project'] or 'global').split('/')[-1]}"
            if error:
                failures.append(f'{label}: {error}')
                continue
            cache[kind][key] = {**answer, 'at':stamp, 'model':MODEL}
            CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'reviewed':len(jobs) - len(failures), 'failed':failures, 'costUsd':round(cost, 4)}))

if __name__ == '__main__': main()
