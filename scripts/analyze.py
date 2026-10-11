"""Turn the raw inventory into things, contexts and findings: what applies where, and what overlaps or conflicts."""
from collections import Counter
import hashlib
import math
from pathlib import Path
import re

HOME = str(Path.home())
PROJECT_ROOTS = ['side-projects', 'projets', 'Documents']
AGENTS = ['Claude', 'Codex', 'Cursor', 'Gemini']
# Claude Code namespaces these as plugin:skill or anthropic-skills:skill, so they never clash by name.
NAMESPACED_SOURCES = {'plugin', 'synced'}
# Bundled commands seen in Claude Code 2.1.296. A skill with the same name replaces the bundled one.
CLAUDE_BUILTIN_COMMANDS = {'code-review', 'security-review', 'simplify', 'init', 'loop', 'schedule', 'run', 'batch', 'doctor', 'review', 'claude-api', 'update-config', 'keybindings-help', 'fewer-permission-prompts', 'plugin-authoring', 'claude-in-chrome', 'workflow-authoring'}
MCP_PRECEDENCE = {'local':0, 'project':1, 'user':2, 'plugin':3}
SIMILARITY_THRESHOLD = 0.3
MAX_SIMILAR_PAIRS = 60
REVIEWED_AGENTS = ('Claude', 'Codex')
# Claude Code keeps skill descriptions within 1% of the context window, about 8,000 characters on a 200k model.
# Codex uses 2% of the window, or 8,000 characters when the window is unknown. Both are estimates; /doctor shows the real figure.
CLAUDE_LISTING_BUDGET_CHARS = 8000
CODEX_LISTING_BUDGET_CHARS = 8000
DESCRIPTION_CAP_CHARS = 1536
INJECTING_EVENTS = {'SessionStart', 'UserPromptSubmit'}
STOPWORDS = set('''a an and are as at be by can do does for from has have how if in into is it its of on or that the this to use used uses using when with without you your user users wants want asks ask asked any all also about after before each every other own via etc e.g like such should must may will would claude codex agent agents skill skills task tasks work working help helps provide provides make makes need needs new one more most only than then them they these those what which who whenever trigger triggers mentions mention request requests including include includes guidance guide expert reference based not but so just'''.split())

def short(path): return str(path).replace(HOME + '/', '~/')

def git_root(folder):
    """Nearest ancestor with a .git folder, bounded by the scanned project roots."""
    path = Path(folder)
    for candidate in [path, *path.parents]:
        if str(candidate) in [HOME] + [f'{HOME}/{r}' for r in PROJECT_ROOTS]: break
        if (candidate / '.git').exists(): return candidate
    return None

def project_for(thing):
    if thing['scope'] == 'User-wide': return None
    folder = Path(thing['folder'])
    root = git_root(folder)
    if not root:
        for top in PROJECT_ROOTS:
            base = Path(HOME) / top
            if folder.is_relative_to(base) and folder != base:
                root = base / folder.relative_to(base).parts[0]
                break
    root = root or folder
    sub = str(folder.relative_to(root)) if folder.is_relative_to(root) else ''
    return {'id':str(root), 'path':str(root), 'subpath':'' if sub == '.' else sub}

def name_projects(projects):
    counts = Counter(Path(p['path']).name for p in projects.values())
    for p in projects.values():
        base = Path(p['path'])
        clashes = counts[base.name] > 1 or base.name in AGENTS
        p['name'] = f'{base.name} · {base.parent.name}' if clashes else base.name

def rule_agents(f, bypath, claude_reached):
    name = Path(f['path']).name
    if f['family'] == 'Codex / shared':
        agents = ['Codex']
        # Claude reads a project AGENTS.md only when no CLAUDE.md sits there or above; never Codex's global file.
        reads_directly = f['scope'] != 'User-wide' and not has_claude_md_above(Path(f['path']).parent, bypath)
        if f['path'] in claude_reached or reads_directly: agents.append('Claude')
        return agents
    if f['family'] == 'Referenced document': return ['Claude'] if f['path'] in claude_reached else []
    return [f['family']] if f['family'] in AGENTS else [f['family']]

def has_claude_md_above(folder, bypath):
    for candidate in [folder, *folder.parents]:
        if str(candidate) == HOME: return False
        if any(str(candidate / n) in bypath for n in ('CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md')): return True
    return False

def claude_import_closure(files, bypath):
    reached = set()
    def walk(path):
        if path in reached: return
        reached.add(path)
        for ref in bypath.get(path, {}).get('imports', []):
            if ref['exists']: walk(ref['path'])
    for f in files:
        if f['family'] == 'Claude': walk(f['path'])
    return reached

def rule_title(text, path):
    return next((m.group(1).strip() for line in text.splitlines() if (m := re.match(r'^#\s+(.+)', line))), Path(path).name)

def strip_frontmatter(text):
    return re.sub(r'^---\s*\n.*?\n---\s*\n', '', text, count=1, flags=re.S).strip()

def build_things(data):
    files = [f for f in data['files'] if f['family'] != 'Skill']
    bypath = {f['path']: f for f in files}
    reached = claude_import_closure(files, bypath)
    things = []
    def add(kind, raw, **fields):
        thing = {'kind':kind, 'scope':raw['scope'], 'folder':raw['folder'], 'paths':[raw['path']], 'keys':[raw['key']], 'firstSeen':raw.get('firstSeen'), 'changedAt':raw.get('changedAt'), 'plugin':raw.get('plugin') if isinstance(raw.get('plugin'), str) else (raw.get('skill', {}).get('plugin') or {}).get('id'), **fields}
        thing['project'] = project_for(thing)
        things.append(thing)
    for f in files:
        if not f['text'].strip() and f['family'] == 'Referenced document': continue
        add('rule', f, name=Path(f['path']).name, title=rule_title(f['text'], f['path']), agents=rule_agents(f, bypath, reached), description='', body=f['text'], sha=f['sha256'], lines=f['lines'], empty=not f['text'].strip(), imports=f['imports'], family=f['family'], loadsWhen='nested' if Path(f['path']).parent != Path(f['folder']) and f['scope'] != 'User-wide' else 'start')
    for f in data['files']:
        if f['family'] != 'Skill': continue
        sk = f['skill']
        add('skill', f, name=sk['name'], title=sk['name'], agents=[sk['agent']], description=sk['description'], body=strip_frontmatter(f['text']), sha=f['sha256'], source=sk['source'], origin=sk.get('origin'), version=(sk.get('plugin') or {}).get('version'), supportFiles=sk['supportFiles'], manualOnly=sk.get('manualOnly'), hiddenFromMenu=sk.get('hiddenFromMenu'), linkTarget=f.get('linkTarget'))
    extras = data.get('extras', {})
    for kind, group in [('command', 'commands'), ('subagent', 'subagents'), ('output-style', 'outputStyles')]:
        for x in extras.get(group, []):
            add(kind, x, name=x['name'], title=x['name'], agents=[x['agent']], description=x.get('description', ''), body=strip_frontmatter(x.get('text', '')), sha=x['sha256'], model=x.get('model'), tools=x.get('tools'))
    for x in extras.get('hooks', []):
        add('hook', x, name=x['event'], title=x['event'] + (f" · {x['matcher']}" if x['matcher'] else ''), agents=[x['agent']], description=x.get('status') or '', body='', sha=x['sha256'], event=x['event'], matcher=x['matcher'], command=x['command'], handlerType=x['handlerType'], timeout=x.get('timeout'))
    for x in extras.get('mcp', []):
        add('mcp', x, name=x['name'], title=x['name'], agents=[x['agent']], description=x['target'], body='', sha=x['sha256'], transport=x['transport'], target=x['target'], mcpScope=x['mcpScope'])
    merge_copies(things)
    projects = {}
    for t in things:
        for p in t['projects']:
            projects.setdefault(p['id'], dict(p))
    name_projects(projects)
    for t in things:
        for p in t['projects']: p['name'] = projects[p['id']]['name']
        t['global'] = not t['projects']
        t['id'] = t['kind'] + '-' + hashlib.sha256('|'.join(sorted(t['keys'])).encode()).hexdigest()[:12]
    return things, sorted(projects.values(), key=lambda p: p['name'].lower())

def merge_copies(things):
    """Identical rule and skill files become one thing with several locations and the union of agents."""
    merged, out = {}, []
    for t in things:
        key = (t['kind'], t['sha']) if t['kind'] in ('rule', 'skill') and not t.get('empty') else None
        project = t.pop('project')
        if key and key in merged:
            m = merged[key]
            m['paths'] += t['paths']; m['keys'] += t['keys']
            m['agents'] = sorted(set(m['agents']) | set(t['agents']))
            if project and project not in m['projects']: m['projects'].append(project)
            if t['scope'] == 'User-wide': m['scope'] = 'User-wide'
            m['firstSeen'] = min(filter(None, [m['firstSeen'], t['firstSeen']]), default=None)
            m['locations'].append({'path':t['paths'][0], 'agents':t['agents'], 'project':project, 'source':t.get('source'), 'linkTarget':t.get('linkTarget')})
            continue
        t['projects'] = [project] if project else []
        t['locations'] = [{'path':t['paths'][0], 'agents':t['agents'], 'project':project, 'source':t.get('source'), 'linkTarget':t.get('linkTarget')}]
        if key: merged[key] = t
        out.append(t)
    things[:] = out

def visible_together(a, b):
    """Two things can only compete when the same agent sees both in at least one place."""
    shared_agents = set(a['agents']) & set(b['agents'])
    if not shared_agents: return None
    if a['global'] and b['global']: return {'agents':sorted(shared_agents), 'where':'everywhere', 'projects':[]}
    if a['global'] or b['global']:
        local = b if a['global'] else a
        return {'agents':sorted(shared_agents), 'where':'projects', 'projects':[p['id'] for p in local['projects']]}
    common = {p['id'] for p in a['projects']} & {p['id'] for p in b['projects']}
    return {'agents':sorted(shared_agents), 'where':'projects', 'projects':sorted(common)} if common else None

def tokens(text):
    return [w for w in re.findall(r'[a-z][a-z0-9]+', text.lower()) if len(w) > 2 and w not in STOPWORDS]

def vectors(things):
    docs = {t['id']: tokens(' '.join([re.sub(r'[-_:]', ' ', t['name'])] * 3) + ' ' + t['description'][:600]) for t in things}
    df = Counter(w for words in docs.values() for w in set(words))
    total = len(docs)
    out = {}
    for tid, words in docs.items():
        tf = Counter(words)
        vec = {w: (c / len(words)) * math.log((1 + total) / (1 + df[w])) for w, c in tf.items()} if words else {}
        norm = math.sqrt(sum(v * v for v in vec.values())) or 1
        out[tid] = {w: v / norm for w, v in vec.items()}
    return out

def cosine(a, b):
    if len(a) > len(b): a, b = b, a
    return sum(v * b.get(w, 0) for w, v in a.items())

def pair_key(a, b): return '|'.join(sorted([a['sha'], b['sha']]))

def plain_name(t): return t['name'].split(':')[-1].lower()

def where_label(together, projects_by_id):
    if together['where'] == 'everywhere': return 'Everywhere'
    names = [projects_by_id[p]['name'] for p in together['projects'] if p in projects_by_id]
    return 'In ' + ', '.join(names[:3]) + (f' +{len(names) - 3}' if len(names) > 3 else '')

def finding(kind, severity, title, summary, happens, todo, items, together, projects_by_id, **extra):
    fid = kind + '-' + hashlib.sha256('|'.join([kind] + sorted(items)).encode()).hexdigest()[:10]
    return {'id':fid, 'kind':kind, 'severity':severity, 'title':title, 'summary':summary, 'happens':happens, 'todo':todo, 'items':items, 'agents':together['agents'] if together else [], 'where':where_label(together, projects_by_id) if together else 'Everywhere', 'projectIds':together['projects'] if together else [], **extra}

def label(t):
    if t['global']: return 'global' if t.get('source') not in ('plugin', 'synced', 'system') else {'plugin':f"plugin {(t.get('plugin') or '').split('@')[0]}", 'synced':'synced from claude.ai', 'system':'built into the app'}[t['source']]
    return 'project ' + ', '.join(p['name'] for p in t['projects'][:2])

def same_name_findings(things, projects_by_id):
    out = []
    callable_things = [t for t in things if t['kind'] in ('skill', 'command')]
    for i, a in enumerate(callable_things):
        for b in callable_things[i + 1:]:
            if plain_name(a) != plain_name(b) or a['sha'] == b['sha'] or 'system' in (a.get('source'), b.get('source')) and a.get('source') == b.get('source'): continue
            together = visible_together(a, b)
            if not together: continue
            if 'Claude' in together['agents'] and (a.get('source') in NAMESPACED_SOURCES or b.get('source') in NAMESPACED_SOURCES or a.get('plugin') or b.get('plugin')): continue
            if together['agents'] == ['Claude']:
                winner, loser = claude_name_winner(a, b)
                happens = f"Typing /{plain_name(a)} or an automatic match always loads the {label(winner)} version. The {label(loser)} one is hidden."
                todo = f"Rename one of them, or delete the {label(loser)} copy if it is outdated."
            else:
                winner = None
                agent = together['agents'][0]
                happens = f'{agent} does not merge or rank skills with the same name. Both can appear in the skill list, so either one may be picked.' if agent == 'Codex' else f'{agent} has no documented rule for two skills with the same name, so either one may be picked.'
                todo = 'Rename one of them so you can tell which one runs.' + (' You can also disable one with [[skills.config]] in ~/.codex/config.toml.' if agent == 'Codex' else '')
            out.append(finding('same-name', 'high', f'Two skills named “{plain_name(a)}”', f"{label(a).capitalize()} and {label(b)} define the same name.", happens, todo, [a['id'], b['id']], together, projects_by_id, winner=winner and winner['id']))
    for t in callable_things:
        if 'Claude' not in t['agents'] or t.get('plugin') or t.get('source') in NAMESPACED_SOURCES or plain_name(t) not in CLAUDE_BUILTIN_COMMANDS: continue
        together = {'agents':['Claude'], 'where':'everywhere' if t['global'] else 'projects', 'projects':[p['id'] for p in t['projects']]}
        out.append(finding('shadows-builtin', 'medium', f'“{plain_name(t)}” replaces a built-in command', f"Claude Code ships its own /{plain_name(t)}. Your {label(t)} {t['kind']} has the same name.", f"Here, /{plain_name(t)} runs your version instead of the built-in one.", 'Keep it if that is intended. Otherwise rename yours to get the built-in back.', [t['id']], together, projects_by_id))
    return out

def claude_name_winner(a, b):
    """Personal beats project; a skill beats a command with the same name."""
    rank = lambda t: (0 if t['global'] else 1, 0 if t['kind'] == 'skill' else 1)
    return (a, b) if rank(a) <= rank(b) else (b, a)

def skill_contexts(things, projects):
    """Every place an agent sees a distinct set of skills: everywhere (global only), plus each project with its own skills."""
    contexts = []
    for agent in REVIEWED_AGENTS:
        pool = [t for t in things if t['kind'] in ('skill', 'command') and agent in t['agents'] and t.get('source') != 'system' and not t.get('manualOnly')]
        global_ids = [t['id'] for t in pool if t['global']]
        candidates = [(None, global_ids, [])] + [(p['id'], global_ids, [t['id'] for t in pool if any(x['id'] == p['id'] for x in t['projects'])]) for p in projects]
        for pid, globals_, local in candidates:
            if pid and not local: continue
            ids = globals_ + local
            if len(ids) < 2: continue
            shas = sorted(t['sha'] for t in pool if t['id'] in ids)
            contexts.append({'key':hashlib.sha256((agent + '|' + '|'.join(shas)).encode()).hexdigest()[:16], 'agent':agent, 'project':pid, 'ids':ids, 'focus':local})
    return contexts

def reviewed_findings(things, contexts, projects_by_id, judgements):
    by_id = {t['id']: t for t in things}
    out, seen = [], set()
    for ctx in contexts:
        for group in judgements.get('skills', {}).get(ctx['key'], {}).get('groups', []):
            ids = [i for i in group.get('ids', []) if i in by_id]
            if len(ids) < 2 or tuple(sorted(ids)) in seen: continue
            seen.add(tuple(sorted(ids)))
            members = [by_id[i] for i in ids]
            together = {'agents':[ctx['agent']], 'where':'everywhere' if all(m['global'] for m in members) else 'projects', 'projects':[] if all(m['global'] for m in members) else ([ctx['project']] if ctx['project'] else [])}
            verdict = group.get('verdict', 'overlap')
            severity = {'conflict':'high', 'duplicate':'high'}.get(verdict, 'medium')
            out.append(finding('overlap', severity, group.get('title') or ' and '.join(plain_name(m) for m in members), group.get('summary', ''), group.get('happens', ''), group.get('advice', ''), ids, together, projects_by_id, verdict=verdict, reviewed=True, likelyPick=group.get('likelyPick')))
    return out

def similar_findings(things, contexts, projects_by_id, judgements):
    """Offline fallback for places the AI review has not covered yet: word overlap between names and descriptions."""
    judged = {c['key'] for c in contexts if c['key'] in judgements.get('skills', {})}
    unjudged = [c for c in contexts if c['key'] not in judged]
    if not unjudged: return []
    pool = [t for t in things if t['kind'] in ('skill', 'command') and t.get('source') != 'system' and not t.get('manualOnly')]
    vecs = vectors(pool)
    by_id = {t['id']: t for t in pool}
    candidates, seen = [], set()
    for ctx in unjudged:
        ids = [i for i in ctx['ids'] if i in by_id]
        focus = set(ctx['focus'])
        for i, a_id in enumerate(ids):
            for b_id in ids[i + 1:]:
                a, b = by_id[a_id], by_id[b_id]
                if focus and a_id not in focus and b_id not in focus: continue
                if a['sha'] == b['sha'] or plain_name(a) == plain_name(b) or (a.get('plugin') and a.get('plugin') == b.get('plugin')): continue
                pair = tuple(sorted([a_id, b_id]))
                if pair in seen: continue
                seen.add(pair)
                score = cosine(vecs[a_id], vecs[b_id])
                if score >= SIMILARITY_THRESHOLD: candidates.append((score, a, b, visible_together(a, b)))
    candidates.sort(key=lambda c: -c[0])
    return [finding('overlap', 'low', f"Possibly overlapping: {plain_name(a)} and {plain_name(b)}", f"Their names and descriptions share {round(score * 100)}% of their key words. Not reviewed yet.", similar_happens(together), 'Open both and compare, or run the AI review for a verdict.', [a['id'], b['id']], together, projects_by_id, score=round(score, 2), verdict='candidate', reviewed=False) for score, a, b, together in candidates[:MAX_SIMILAR_PAIRS]]

def similar_happens(together):
    if together['agents'] == ['Codex']: return 'Codex lists both and picks by description. There is no documented tie-break.'
    return 'Claude reads both descriptions and picks the closest match. There is no documented tie-break, so it may pick either one or load both.'

def mcp_findings(things, projects_by_id):
    out = []
    servers = [t for t in things if t['kind'] == 'mcp' and t['agents'] == ['Claude']]
    for i, a in enumerate(servers):
        for b in servers[i + 1:]:
            if a['name'] != b['name']: continue
            together = visible_together(a, b)
            if not together: continue
            winner, loser = sorted([a, b], key=lambda t: MCP_PRECEDENCE.get(t['mcpScope'], 9))
            same = a['sha'] == b['sha']
            out.append(finding('same-name', 'low' if same else 'medium', f'MCP server “{a["name"]}” is configured twice', f"Defined at {winner['mcpScope']} scope and at {loser['mcpScope']} scope.", f"Claude Code uses the whole {winner['mcpScope']} entry and ignores the {loser['mcpScope']} one. Settings are not merged." + (' Both point to the same place.' if same else ' They point to different places.'), 'Remove the one you no longer need so there is a single source of truth.', [winner['id'], loser['id']], together, projects_by_id, winner=winner['id']))
    return out

def rule_stack(things, project_id, agent):
    rules = [t for t in things if t['kind'] == 'rule' and agent in t['agents'] and not t.get('empty') and (t['global'] or any(p['id'] == project_id for p in t['projects']))]
    return sorted(rules, key=lambda t: (not t['global'], len(t['paths'][0])))

def rule_findings(things, projects, projects_by_id, judgements):
    out, stacks = [], []
    for p in projects:
        for agent in ('Claude', 'Codex'):
            stack = rule_stack(things, p['id'], agent)
            if len(stack) < 2 or all(t['global'] for t in stack): continue
            key = hashlib.sha256(('|'.join(sorted(t['sha'] for t in stack)) + agent).encode()).hexdigest()[:16]
            stacks.append({'key':key, 'project':p['id'], 'agent':agent, 'rules':[t['id'] for t in stack]})
            for conflict in judgements.get('rules', {}).get(key, {}).get('conflicts', []):
                if conflict.get('resolved'): continue
                removed = {r['text']: r.get('backup') for r in conflict.get('removed', [])}
                quotes = [{**q, 'removed':q['text'] in removed, 'backup':removed.get(q['text'])} for q in conflict.get('quotes', [])]
                together = {'agents':[agent], 'where':'projects', 'projects':[p['id']]}
                ids = [t['id'] for t in stack if Path(t['paths'][0]).name in conflict.get('files', []) or any(short(x) in conflict.get('files', []) for x in t['paths'])] or [t['id'] for t in stack]
                out.append(finding('contradiction', 'high', conflict.get('title', 'Rules that contradict'), conflict.get('explanation', ''), conflict.get('happens') or 'Both rules load into the same session. When instructions contradict, Claude may pick either one.', conflict.get('advice', ''), ids, together, projects_by_id, quotes=quotes, partlyFixed=any(q['removed'] for q in quotes), reviewed=True))
        claude_md = [t for t in things if t['kind'] == 'rule' and t['family'] == 'Claude' and any(x['id'] == p['id'] for x in t['projects']) and not t.get('empty')]
        agents_md = [t for t in things if t['kind'] == 'rule' and t['family'] == 'Codex / shared' and any(x['id'] == p['id'] for x in t['projects']) and 'Claude' not in t['agents'] and not t.get('empty')]
        if claude_md and agents_md:
            together = {'agents':['Claude', 'Codex'], 'where':'projects', 'projects':[p['id']]}
            out.append(finding('drift', 'medium', f'Claude and Codex get different instructions in {p["name"]}', 'This project has both a CLAUDE.md and an AGENTS.md, and CLAUDE.md does not import AGENTS.md.', 'Claude reads CLAUDE.md and ignores AGENTS.md here. Codex reads only AGENTS.md. The two agents follow different rules in the same repo.', 'If they should match, keep one file and add a line with @AGENTS.md to CLAUDE.md.', [t['id'] for t in claude_md + agents_md], together, projects_by_id))
    return out, stacks

def listing_findings(things, projects, projects_by_id):
    out, budgets = [], []
    for agent, limit in (('Claude', CLAUDE_LISTING_BUDGET_CHARS), ('Codex', CODEX_LISTING_BUDGET_CHARS)):
        contexts = [None] + [p['id'] for p in projects]
        for pid in contexts:
            skills = [t for t in things if t['kind'] in ('skill', 'command') and agent in t['agents'] and not t.get('manualOnly') and (t['global'] or (pid and any(p['id'] == pid for p in t['projects'])))]
            size = sum(len(t['name']) + min(len(t['description']), DESCRIPTION_CAP_CHARS) for t in skills)
            budgets.append({'agent':agent, 'project':pid, 'count':len(skills), 'chars':size, 'limit':limit})
        worst = max((b for b in budgets if b['agent'] == agent), key=lambda b: b['chars'], default=None)
        if worst and worst['chars'] > limit:
            over = [b for b in budgets if b['agent'] == agent and b['chars'] > limit]
            together = {'agents':[agent], 'where':'everywhere' if any(b['project'] is None for b in over) else 'projects', 'projects':[b['project'] for b in over if b['project']]}
            check = 'Run /doctor in Claude Code to see the real figure for your model.' if agent == 'Claude' else 'The budget is larger on models with a bigger context window.'
            out.append(finding('budget', 'medium', f'{agent} may not see every skill description', f"Up to {worst['count']} skills with about {worst['chars']:,} characters of descriptions. The estimated budget is {limit:,} characters on a 200k-context model.", f"{agent} always keeps every skill name, but drops descriptions once the list is too long" + (', starting with the skills you use least.' if agent == 'Claude' else '.') + f' A skill without its description is much less likely to be picked automatically. {check}', 'Disable plugins you do not use, or mark rarely used skills as manual only with disable-model-invocation: true.', [], together, projects_by_id, estimate=True))
    return out, budgets

def hook_findings(things, projects_by_id):
    out = []
    for t in things:
        if t['kind'] != 'hook': continue
        together = {'agents':t['agents'], 'where':'everywhere' if t['global'] else 'projects', 'projects':[p['id'] for p in t['projects']]}
        if t['event'] in INJECTING_EVENTS and 'inject' in t['command'].lower():
            out.append(finding('hidden', 'medium', f"A hook adds instructions to every session", f"{label(t).capitalize()} runs a {t['event']} hook that injects text into the conversation.", 'These instructions never appear in any CLAUDE.md, so they are easy to forget. They load everywhere the hook applies.', 'Open the hook to see what it adds. Disable the plugin if you do not want it.', [t['id']], together, projects_by_id))
    return out

def merge_repeated(findings, projects_by_id):
    """The same issue found in several projects (for example two clones of one repo) becomes one finding."""
    merged = {}
    for f in findings:
        key = (f['kind'], f['title'].lower(), tuple(sorted(f['items'])))
        if key not in merged:
            merged[key] = f
            continue
        m = merged[key]
        if m['where'] == 'Everywhere' or f['where'] == 'Everywhere':
            m['where'], m['projectIds'] = 'Everywhere', []
            continue
        m['projectIds'] = sorted(set(m['projectIds']) | set(f['projectIds']))
        m['where'] = where_label({'where':'projects', 'projects':m['projectIds']}, projects_by_id)
    return list(merged.values())

def analyze(data, judgements=None):
    judgements = judgements or {}
    things, projects = build_things(data)
    projects_by_id = {p['id']: p for p in projects}
    findings = []
    findings += same_name_findings(things, projects_by_id)
    contexts = skill_contexts(things, projects)
    findings += reviewed_findings(things, contexts, projects_by_id, judgements)
    findings += similar_findings(things, contexts, projects_by_id, judgements)
    findings += mcp_findings(things, projects_by_id)
    rules, stacks = rule_findings(things, projects, projects_by_id, judgements)
    findings += rules
    budget, budgets = listing_findings(things, projects, projects_by_id)
    findings += budget
    findings += hook_findings(things, projects_by_id)
    findings = merge_repeated(findings, projects_by_id)
    order = {'high':0, 'medium':1, 'low':2}
    findings.sort(key=lambda f: (order[f['severity']], f['kind'], f['title']))
    return {'things':things, 'projects':projects, 'findings':findings, 'contexts':contexts, 'stacks':stacks, 'budgets':budgets}
