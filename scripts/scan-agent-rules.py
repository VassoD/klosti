#!/usr/bin/env python3
"""Read-only inventory of agent instruction files, skills, commands, subagents, hooks and MCP servers. No network requests."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import tomllib

HOME = Path.home()
AGENT_DIRS = ['.claude', '.codex', '.agents', '.cursor', '.gemini', '.windsurf', '.copilot', '.continue']
DEFAULT_ROOTS = [HOME / p for p in ['side-projects', 'projets', 'Documents', *AGENT_DIRS]]
RULE_NAMES = {'AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', 'CLAUDE.local.md', 'GEMINI.md', '.cursorrules', '.windsurfrules', 'copilot-instructions.md'}
RULE_DIRS = ['/.claude/rules/', '/.cursor/rules/', '/.windsurf/rules/']
SKILL_NAME = 'SKILL.md'
SKILLS_LOCK = 'skills-lock.json'
# Plugin parts are read from the enabled plugin list instead, so stale cached versions are skipped.
EXCLUDED = ['node_modules', '.git', 'vendor', '.venv', 'plugins', 'worktrees', 'cache', 'sessions', 'history', 'extensions', '.next', 'build', '.trash', 'vendor_imports', '.tmp']
HISTORY_LIMIT = 200
COMMAND_PREVIEW_CHARS = 4000
HOOK_COMMAND_CHARS = 280
CLAUDE_JSON = HOME / '.claude.json'
CLAUDE_INSTALLED_PLUGINS = HOME / '.claude/plugins/installed_plugins.json'
CLAUDE_SETTINGS = HOME / '.claude/settings.json'
CODEX_CONFIG = HOME / '.codex/config.toml'
CODEX_PLUGIN_CACHE = HOME / '.codex/plugins/cache'
SECRET_ASSIGNMENT = re.compile(r'(?i)\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|AUTH)[A-Z0-9_]*)=\S+')
LONG_TOKEN = re.compile(r'[A-Za-z0-9_\-]{32,}')
PACKAGE_ARG = re.compile(r'^@?[a-z0-9][\w.-]*(/[\w.-]+)?(@[\w.-]+)?$', re.I)

def now_iso(): return datetime.datetime.now().astimezone().isoformat(timespec='seconds')

def family(path):
    s = str(path)
    if path.name.startswith('AGENTS'): return 'Codex / shared'
    if path.name.startswith('CLAUDE') or '/.claude/rules/' in s: return 'Claude'
    if path.name == '.cursorrules' or '/.cursor/rules/' in s: return 'Cursor'
    if path.name == 'GEMINI.md': return 'Gemini'
    if 'windsurf' in s: return 'Windsurf'
    return 'Copilot'

def scope(path):
    for agent in AGENT_DIRS:
        if Path(path).is_relative_to(HOME / agent): return 'User-wide'
    return 'Folder'

def folder_for(path):
    for marker in ['/.claude/', '/.agents/', '/.cursor/', '/.codex/', '/.windsurf/', '/.github/']:
        if marker in str(path) and scope(path) != 'User-wide': return str(path).split(marker)[0]
    return str(Path(path).parent)

def agent_for(path):
    s = str(path)
    if '/.claude/' in s or s.endswith('/.mcp.json'): return 'Claude'
    if '/.codex/' in s or '/.agents/' in s: return 'Codex'
    if '/.cursor/' in s: return 'Cursor'
    if '/.gemini/' in s: return 'Gemini'
    return 'Other'

def record(path, kind=None):
    raw = path.read_bytes()
    body = raw.decode('utf-8', errors='replace')
    return {'path':str(path), 'key':str(path), 'folder':folder_for(path), 'family':kind or family(path), 'scope':scope(path), 'bytes':len(raw), 'lines':len(body.splitlines()), 'modified':datetime.datetime.fromtimestamp(path.stat().st_mtime).astimezone().isoformat(timespec='seconds'), 'sha256':hashlib.sha256(raw).hexdigest(), 'text':body, 'imports':[]}

def is_rule(path):
    return path.name in RULE_NAMES or path.name.endswith('.instructions.md') or any(d in str(path) for d in RULE_DIRS)

def config_kind(path):
    """Classify the configuration files that hold commands, subagents, hooks and MCP servers."""
    s, name, parent = str(path), path.name, path.parent.name
    if name == SKILLS_LOCK: return 'skills-lock'
    if name == '.mcp.json': return 'mcp-json'
    if parent == '.claude' and name in ('settings.json', 'settings.local.json'): return 'claude-settings'
    if parent == '.cursor' and name == 'mcp.json': return 'cursor-mcp'
    if parent == '.codex' and name in ('config.toml', 'hooks.json'): return 'codex-config'
    if name.endswith('.md') and '/.claude/commands/' in s: return 'command'
    if name.endswith('.md') and parent == 'agents' and path.parent.parent.name == '.claude': return 'subagent'
    if name.endswith('.md') and parent == 'output-styles' and path.parent.parent.name == '.claude': return 'output-style'
    return None

def linked_skill_files(link, inside_skills_dir):
    """Skill folders are often symlinks (for example `npx skills` links .claude/skills to .agents/skills)."""
    candidates = [link / SKILL_NAME] if inside_skills_dir else list(link.glob('*/' + SKILL_NAME))
    return [p for p in candidates if p.is_file()]

def discover(roots, errors):
    """Walk roots like `rg --files --hidden --no-ignore`, pruning excluded folder names.
    Returns the roots that could not be listed at all, for example when macOS privacy settings block a background job."""
    found = {'rules':set(), 'skills':set(), 'config':{}}
    unreadable = []
    def on_error(exc):
        errors.append(str(exc))
        if exc.filename and Path(exc.filename) in roots: unreadable.append(Path(exc.filename))
    for root in roots:
        for dirpath, dirnames, filenames in os.walk(root, onerror=on_error):
            dirnames[:] = [d for d in dirnames if d not in EXCLUDED]
            here = Path(dirpath)
            for d in dirnames:
                if (here / d).is_symlink() and (d == 'skills' or here.name == 'skills'):
                    found['skills'].update(linked_skill_files(here / d, here.name == 'skills'))
            for name in filenames:
                path = here / name
                if name == SKILL_NAME: found['skills'].add(path)
                elif is_rule(path): found['rules'].add(path)
                elif kind := config_kind(path): found['config'].setdefault(kind, set()).add(path)
    return found, unreadable

def frontmatter(text):
    """Minimal YAML front matter reader for the flat keys skills, commands and subagents use."""
    match = re.match(r'^---\s*\n(.*?)\n---\s*(?:\n|$)', text, re.S)
    if not match: return {}
    meta, lines, i = {}, match.group(1).splitlines(), 0
    while i < len(lines):
        found = re.match(r'^([A-Za-z0-9_-]+):\s*(.*)$', lines[i])
        i += 1
        if not found: continue
        key, value = found.group(1), found.group(2).strip()
        if value in ('>', '|', '>-', '|-', ''):
            block = []
            while i < len(lines) and (not lines[i].strip() or lines[i].startswith((' ', '\t'))):
                block.append(lines[i].strip()); i += 1
            value = (' ' if value.startswith('>') or not value else '\n').join(b for b in block if b)
        meta[key] = value.strip().strip('"\'')
    return meta

def strip_frontmatter(text):
    return re.sub(r'^---\s*\n.*?\n---\s*\n', '', text, count=1, flags=re.S).strip()

def first_line(text):
    return next((line.strip('# ').strip() for line in strip_frontmatter(text).splitlines() if line.strip()), '')

def skill_source(path, plugin):
    s = str(path)
    if plugin: return 'plugin'
    if '/.claude/skills/synced/' in s: return 'synced'
    if any(marker in s for marker in ['/.codex/skills/.system/', '/.cursor/skills-cursor/', '/builtin/skills/']): return 'system'
    return 'user' if scope(path) == 'User-wide' else 'project'

def support_file_count(skill_dir):
    count = 0
    for dirpath, dirnames, filenames in os.walk(skill_dir):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDED]
        count += len(filenames)
    return count - 1

def skill_record(path, plugin=None, origins=None):
    item = record(path, 'Skill')
    meta = frontmatter(item['text'])
    if plugin: item['key'] = 'plugin:' + plugin['id'] + ':' + str(path.relative_to(plugin['root']))
    if path.parent.is_symlink(): item['linkTarget'] = str(path.resolve())
    origin = plugin['id'] if plugin else (origins or {}).get((item['folder'], path.parent.name))
    item['skill'] = {'name':meta.get('name') or path.parent.name, 'description':meta.get('description', ''), 'agent':plugin['agent'] if plugin else agent_for(path), 'source':skill_source(path, plugin), 'origin':origin, 'plugin':plugin and {'id':plugin['id'], 'version':plugin['version'], 'installedAt':plugin.get('installedAt')}, 'supportFiles':support_file_count(path.parent), 'manualOnly':meta.get('disable-model-invocation') == 'true', 'hiddenFromMenu':meta.get('user-invocable') == 'false'}
    return item

def skill_origins(lock_files, errors):
    """Map (project folder, skill folder name) to the repository a skills CLI installed it from."""
    origins = {}
    for lock in lock_files:
        try:
            for name, entry in json.loads(lock.read_text()).get('skills', {}).items():
                origins[(str(lock.parent), name)] = entry.get('source')
        except (OSError, ValueError) as exc: errors.append(f'{lock}: {exc}')
    return origins

def latest_child(folder):
    children = [p for p in folder.iterdir() if p.is_dir()] if folder.is_dir() else []
    return max(children, key=lambda p: p.stat().st_mtime, default=None)

def read_json(path, errors):
    try: return json.loads(Path(path).read_text())
    except (OSError, ValueError) as exc:
        errors.append(f'{path}: {exc}')
        return {}

def read_toml(path, errors):
    try: return tomllib.loads(Path(path).read_text())
    except (OSError, ValueError) as exc:
        errors.append(f'{path}: {exc}')
        return {}

def enabled_plugins(errors):
    """Enabled Claude Code and Codex plugins with the folder holding their current version."""
    plugins = []
    installed = read_json(CLAUDE_INSTALLED_PLUGINS, errors).get('plugins', {}) if CLAUDE_INSTALLED_PLUGINS.exists() else {}
    enabled = read_json(CLAUDE_SETTINGS, errors).get('enabledPlugins', {}) if CLAUDE_SETTINGS.exists() else {}
    for plugin_id, entries in installed.items():
        if not enabled.get(plugin_id): continue
        for entry in entries:
            plugins.append({'id':plugin_id, 'agent':'Claude', 'root':Path(entry['installPath']), 'version':entry.get('version'), 'installedAt':entry.get('installedAt')})
    config = read_toml(CODEX_CONFIG, errors) if CODEX_CONFIG.exists() else {}
    for plugin_id, settings in config.get('plugins', {}).items():
        if not settings.get('enabled') or '@' not in plugin_id: continue
        name, marketplace = plugin_id.split('@', 1)
        root = latest_child(CODEX_PLUGIN_CACHE / marketplace / name)
        if root: plugins.append({'id':plugin_id, 'agent':'Codex', 'root':root, 'version':root.name})
    return plugins

def redact(command):
    """Hook commands are shown to the user, so mask anything that looks like a credential."""
    text = str(command).replace(str(HOME), '~')
    text = SECRET_ASSIGNMENT.sub(lambda m: m.group(1) + '=•••', text)
    text = LONG_TOKEN.sub('•••', text)
    return text if len(text) <= HOOK_COMMAND_CHARS else text[:HOOK_COMMAND_CHARS] + '…'

def base_item(kind, name, agent, source, folder=None, plugin=None, user_wide=None):
    folder = folder or folder_for(source)
    wide = scope(source) == 'User-wide' if user_wide is None else user_wide
    return {'kind':kind, 'name':name, 'agent':agent, 'path':str(source), 'folder':str(HOME) if wide else str(folder), 'scope':'User-wide' if wide else 'Folder', 'plugin':plugin and plugin['id']}

def hook_items(hooks, agent, source, errors, plugin=None, folder=None, user_wide=None):
    items = []
    if not isinstance(hooks, dict): return items
    for event, groups in hooks.items():
        for group in groups if isinstance(groups, list) else []:
            for handler in group.get('hooks', []) if isinstance(group, dict) else []:
                command = handler.get('command') or handler.get('url') or handler.get('prompt') or handler.get('type', '')
                item = base_item('hook', event, agent, source, folder, plugin, user_wide)
                item.update({'event':event, 'matcher':group.get('matcher') or '', 'handlerType':handler.get('type', 'command'), 'command':redact(command), 'timeout':handler.get('timeout'), 'status':handler.get('statusMessage')})
                item['key'] = f"hook:{item['path']}:{event}:{item['matcher']}:{hashlib.sha256(str(command).encode()).hexdigest()[:10]}"
                item['sha256'] = item['key']
                items.append(item)
    return items

def mcp_target(server):
    if server.get('url'):
        url = re.sub(r'[?#].*$', '', server['url'])
        return re.sub(r'^(https?://)[^/@]*@', r'\1', url)
    command = Path(str(server.get('command', ''))).name
    package = next((a for a in server.get('args', []) if isinstance(a, str) and PACKAGE_ARG.match(a) and not LONG_TOKEN.search(a) and not a.startswith('-')), '')
    return f'{command} {package}'.strip()

def mcp_items(servers, agent, source, mcp_scope, plugin=None, folder=None, user_wide=None):
    """Only names, transport and host are kept. Environment variables, headers and arguments can hold secrets."""
    items = []
    for name, server in (servers or {}).items():
        if not isinstance(server, dict): continue
        item = base_item('mcp', name, agent, source, folder, plugin, user_wide)
        transport = server.get('type') or server.get('transport') or ('http' if server.get('url') else 'stdio')
        item.update({'transport':transport, 'target':mcp_target(server), 'mcpScope':mcp_scope, 'enabled':server.get('enabled', True) is not False})
        item['key'] = f"mcp:{agent}:{item['folder']}:{name}:{mcp_scope}"
        item['sha256'] = hashlib.sha256(json.dumps([transport, item['target']]).encode()).hexdigest()
        items.append(item)
    return items

def markdown_item(kind, path, agent, plugin=None, prefix=''):
    text = path.read_text(errors='replace')
    meta = frontmatter(text)
    item = base_item(kind, prefix + (meta.get('name') or path.stem), agent, path, plugin=plugin)
    item.update({'description':meta.get('description') or first_line(text), 'model':meta.get('model'), 'tools':meta.get('tools'), 'text':text[:COMMAND_PREVIEW_CHARS], 'truncated':len(text) > COMMAND_PREVIEW_CHARS})
    item['key'] = f'{kind}:{plugin["id"] + ":" if plugin else ""}{path.relative_to(plugin["root"]) if plugin else path}'
    item['sha256'] = hashlib.sha256(text.encode()).hexdigest()
    return item

def plugin_markdown(plugin, folder, kind):
    root = plugin['root'] / folder
    paths = sorted(p for p in root.glob('*.md') if not p.name.startswith('_')) if root.is_dir() else []
    return [markdown_item(kind, p, plugin['agent'], plugin, plugin['id'].split('@')[0] + ':') for p in paths]

def collect_extras(config_files, plugins, errors):
    extras = {'commands':[], 'subagents':[], 'hooks':[], 'mcp':[], 'outputStyles':[]}
    for path in sorted(config_files.get('command', [])):
        try: extras['commands'].append(markdown_item('command', path, 'Claude'))
        except OSError as exc: errors.append(str(exc))
    for path in sorted(config_files.get('subagent', [])):
        try: extras['subagents'].append(markdown_item('subagent', path, 'Claude'))
        except OSError as exc: errors.append(str(exc))
    for path in sorted(config_files.get('output-style', [])):
        try: extras['outputStyles'].append(markdown_item('output-style', path, 'Claude'))
        except OSError as exc: errors.append(str(exc))
    for path in sorted(config_files.get('claude-settings', [])):
        extras['hooks'] += hook_items(read_json(path, errors).get('hooks'), 'Claude', path, errors)
    for path in sorted(config_files.get('mcp-json', [])):
        extras['mcp'] += mcp_items(read_json(path, errors).get('mcpServers'), 'Claude', path, 'project', folder=path.parent, user_wide=False)
    for path in sorted(config_files.get('cursor-mcp', [])):
        extras['mcp'] += mcp_items(read_json(path, errors).get('mcpServers'), 'Cursor', path, 'user' if scope(path) == 'User-wide' else 'project')
    for path in sorted(config_files.get('codex-config', [])):
        data = read_toml(path, errors) if path.suffix == '.toml' else read_json(path, errors)
        extras['hooks'] += hook_items(data.get('hooks'), 'Codex', path, errors)
        if path.suffix == '.toml': extras['mcp'] += mcp_items(data.get('mcp_servers'), 'Codex', path, 'user' if scope(path) == 'User-wide' else 'project')
    if CLAUDE_JSON.exists():
        claude_json = read_json(CLAUDE_JSON, errors)
        extras['mcp'] += mcp_items(claude_json.get('mcpServers'), 'Claude', CLAUDE_JSON, 'user', user_wide=True)
        for project, settings in claude_json.get('projects', {}).items():
            extras['mcp'] += mcp_items(settings.get('mcpServers'), 'Claude', CLAUDE_JSON, 'local', folder=project, user_wide=False)
    for plugin in plugins:
        if plugin['agent'] != 'Claude': continue
        extras['commands'] += plugin_markdown(plugin, 'commands', 'command')
        extras['subagents'] += plugin_markdown(plugin, 'agents', 'subagent')
        hooks_file = plugin['root'] / 'hooks/hooks.json'
        if hooks_file.exists():
            data = read_json(hooks_file, errors)
            extras['hooks'] += hook_items(data.get('hooks', data), 'Claude', hooks_file, errors, plugin, user_wide=True)
        manifest = read_json(plugin['root'] / '.claude-plugin/plugin.json', errors) if (plugin['root'] / '.claude-plugin/plugin.json').exists() else {}
        servers = dict(read_json(plugin['root'] / '.mcp.json', errors).get('mcpServers', {})) if (plugin['root'] / '.mcp.json').exists() else {}
        if isinstance(manifest.get('mcpServers'), dict): servers.update(manifest['mcpServers'])
        extras['mcp'] += mcp_items(servers, 'Claude', plugin['root'] / '.mcp.json', 'plugin', plugin, user_wide=True)
    return extras

def tracked_name(item):
    if item.get('family') == 'Skill': return item['skill']['name']
    return item.get('name') or Path(item['path']).name

def tracked_kind(item):
    if 'family' in item: return 'skill' if item['family'] == 'Skill' else 'rule'
    return item['kind']

def tracked_agent(item):
    if item.get('family') == 'Skill': return item['skill']['agent']
    return item.get('agent') or item.get('family', '')

def all_tracked(data):
    return data.get('files', []) + [x for group in data.get('extras', {}).values() for x in group]

def track_changes(previous, current, now):
    """Carry first-seen dates across scans and return what changed since the last scan."""
    old = {x.get('key', x.get('path')): x for x in all_tracked(previous)}
    for item in current:
        before = old.get(item['key'])
        item['firstSeen'] = before.get('firstSeen', now) if before else now
        item['changedAt'] = before.get('changedAt') if before else None
        if before and before.get('sha256') != item['sha256']: item['changedAt'] = now
    empty = {'added':[], 'removed':[], 'changed':[]}
    if not previous.get('extrasTracked'): return empty
    summary = lambda x: {'key':x['key'], 'kind':tracked_kind(x), 'name':tracked_name(x), 'agent':tracked_agent(x), 'path':x['path']}
    now_keys = {x['key']: x for x in current}
    return {'added':[summary(x) for k, x in now_keys.items() if k not in old], 'removed':[summary(x) for k, x in old.items() if k not in now_keys], 'changed':[summary(x) for k, x in now_keys.items() if k in old and old[k].get('sha256') != x['sha256']]}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', action='append', help='Scan these roots instead of the default project and agent folders')
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'data/agent-rules-inventory.json')
    args = parser.parse_args()
    roots = [Path(p).expanduser() for p in args.root] if args.root else DEFAULT_ROOTS
    roots = [p for p in roots if p.exists()]
    errors = []
    previous = {}
    if args.output.exists():
        try: previous = json.loads(args.output.read_text())
        except ValueError as exc: errors.append('Previous inventory unreadable: ' + str(exc))
    now = now_iso()
    found, unreadable = discover(roots, errors)
    paths = found['rules']
    for name in ['AGENTS.md','AGENTS.override.md','CLAUDE.md','CLAUDE.local.md','GEMINI.md']:
        if (HOME/name).is_file(): paths.add(HOME/name)
    policy = Path('/Library/Application Support/ClaudeCode/CLAUDE.md')
    if policy.is_file(): paths.add(policy)
    files = []
    for path in sorted(paths):
        try: files.append(record(path))
        except OSError as exc: errors.append(str(exc))
    # Record literal standalone @file references, without executing any instructions.
    by_path = {f['path']: f for f in files}
    for depth in range(4):
        additions = []
        for item in list(by_path.values()):
            for ref in re.findall(r'^@([^\s]+)\s*$', item['text'], re.M):
                target = Path(ref).expanduser()
                if not target.is_absolute(): target = Path(item['path']).parent/target
                target = target.resolve()
                link = {'path':str(target), 'exists':target.is_file()}
                if link not in item['imports']: item['imports'].append(link)
                if target.is_file() and target.suffix == '.md' and str(target) not in by_path:
                    try: additions.append(record(target, 'Referenced document'))
                    except OSError as exc: errors.append(str(exc))
        for item in additions: by_path[item['path']] = item
        if not additions: break
    origins = skill_origins(found['config'].get('skills-lock', []), errors)
    skills = []
    for path in sorted(found['skills']):
        try: skills.append(skill_record(path, origins=origins))
        except OSError as exc: errors.append(str(exc))
    plugins = enabled_plugins(errors)
    for plugin in plugins:
        for path in sorted((plugin['root'] / 'skills').glob('*/' + SKILL_NAME)):
            try: skills.append(skill_record(path, plugin))
            except OSError as exc: errors.append(str(exc))
    items = list(by_path.values()) + skills
    extras = collect_extras(found['config'], plugins, errors)
    # Keep the last known entries for unreadable roots so a blocked scan does not look like deletions.
    known = {x['key'] for x in items + [x for group in extras.values() for x in group]}
    for root in unreadable:
        kept = [f for f in previous.get('files', []) if Path(f['path']).is_relative_to(root) and f.get('key', f['path']) not in known]
        items += kept
        for group, entries in previous.get('extras', {}).items():
            extras.setdefault(group, []).extend(x for x in entries if Path(x['path']).is_relative_to(root) and x['key'] not in known)
        errors.append(f'{root} could not be read; kept {len(kept)} files from the previous scan.')
    changes = track_changes(previous, items + [x for group in extras.values() for x in group], now)
    history = previous.get('history', [])
    if any(changes.values()): history = (history + [{'at':now, **changes}])[-HISTORY_LIMIT:]
    memories = []
    for p in sorted((HOME/'.claude/projects').glob('*/memory/MEMORY.md')):
        memories.append({'path':str(p), 'projectKey':p.parent.parent.name, 'topicFiles':len(list(p.parent.glob('*.md')))})
    permission_sources = []
    for p in sorted((HOME/'.codex/rules').glob('*.rules')):
        permission_sources.append({'path':str(p),'detail':str(len(p.read_text().splitlines()))+' lines; execution policy, contents not copied'})
    if CLAUDE_SETTINGS.exists():
        d = read_json(CLAUDE_SETTINGS, errors)
        counts = {k:len(v) for k,v in d.get('permissions',{}).items() if isinstance(v,list)}
        permission_sources.append({'path':str(CLAUDE_SETTINGS),'detail':'Permission entries: '+json.dumps(counts)+'; '+str(len(d.get('enabledPlugins',{})))+' configured plugin entries'})
    tracked_since = previous.get('baselineAt') if previous.get('extrasTracked') else now
    data = {'scannedAt':now, 'baselineAt':tracked_since, 'extrasTracked':True, 'roots':list(map(str,roots)), 'excluded':EXCLUDED, 'errors':errors, 'files':items, 'extras':extras, 'primaryFileCount':len(files), 'skillCount':len(skills), 'plugins':[{'id':p['id'], 'agent':p['agent'], 'version':p['version'], 'path':str(p['root']), 'installedAt':p.get('installedAt')} for p in plugins], 'history':history, 'memories':memories, 'permissionSources':permission_sources, 'limits':['Finding a file does not prove a running session loaded it.', 'Account-level instructions and connectors (claude.ai, ChatGPT), conversation prompts and managed settings are not fully inventoried.', 'Plugin parts come from enabled Claude Code and Codex plugins only.', 'MCP entries keep only the server name, transport and host. Environment variables, headers and arguments are never copied.', 'Hook commands are shown with anything that looks like a credential masked.', 'Imports: only standalone @file references, up to four rounds.', 'Excluded directories and projects outside scanned roots are not covered.']}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(data, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps({'output':str(args.output), 'primaryFiles':len(files), 'referencedFiles':len(by_path)-len(files), 'skills':len(skills), 'plugins':len(plugins), **{k:len(v) for k,v in extras.items()}, 'added':changes['added'], 'removed':changes['removed'], 'changed':changes['changed'], 'scanErrors':errors}))

if __name__ == '__main__': main()
