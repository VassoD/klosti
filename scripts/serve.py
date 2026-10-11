#!/usr/bin/env python3
"""Serve the Rulebook on localhost so the page can fix things: delete a contradicting rule line,
move a skill to the Trash, or disable a plugin.

Only listens on 127.0.0.1, requires a per-run token, and only acts on items found by the last scan.
Rule edits are backed up first and can be undone from the page."""
import argparse
import datetime
import difflib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import threading
import webbrowser

sys.path.insert(0, str(Path(__file__).resolve().parent))
from analyze import analyze  # noqa: E402
from judge import ask  # noqa: E402

BASE = Path(__file__).resolve().parents[1]
UI_DATA = BASE / 'data/ui-data.json'
INVENTORY = BASE / 'data/agent-rules-inventory.json'
JUDGEMENTS = BASE / 'data/judgements.json'
BACKUPS = BASE / 'data/backups'
BACKUP_MANIFEST = BACKUPS / 'manifest.json'
ACTIONS = BASE / 'data/actions.json'
ACTIONS_LIMIT = 300
INDEX = BASE / 'index.html'
HOME = Path.home()
DEFAULT_PORT = 4711
MAX_BODY_BYTES = 10_000
REMOVABLE_KINDS = {'skill', 'command', 'subagent'}
PROTECTED_MARKERS = ['/plugins/', '/skills/synced/', '/skills/.system/', '/skills-cursor/', '/builtin/skills/']
FUZZY_MATCH_RATIO = 0.82
CLAUDE_FALLBACK = HOME / '.local/bin/claude'
TOKEN = secrets.token_urlsafe(24)
FIX_FILE_CHARS = 40000
MAX_PROPOSALS = 20
# AI proposals stay on the server, so the page can only apply exactly what was previewed.
PROPOSALS = {}
FIX_SCHEMA = {'type':'object', 'properties':{
    'summary':{'type':'string'},
    'edits':{'type':'array', 'items':{'type':'object', 'properties':{'file':{'type':'string'}, 'find':{'type':'string'}, 'replace':{'type':'string'}}, 'required':['file', 'find', 'replace']}}},
    'required':['summary', 'edits']}
# One change at a time: each one rescans and rewrites the cache.
CHANGE_LOCK = threading.Lock()

class RequestRefused(Exception):
    """A request the server refuses, with a message safe to show in the page."""

def ui_data(): return json.loads(UI_DATA.read_text())

def load_judgements():
    cache = json.loads(JUDGEMENTS.read_text()) if JUDGEMENTS.exists() else {}
    cache.setdefault('skills', {}); cache.setdefault('rules', {})
    return cache

def find_thing(data, thing_id):
    thing = next((t for t in data['things'] if t['id'] == thing_id), None)
    if not thing: raise RequestRefused('This item is no longer in the scan. Reload the page.')
    return thing

def find_finding(data, finding_id):
    finding = next((f for f in data['findings'] if f['id'] == finding_id), None)
    if not finding: raise RequestRefused('This issue is no longer in the scan. Reload the page.')
    return finding

# ---- rule lines -------------------------------------------------------------

def normalize(text):
    text = re.sub(r'^\s*(?:[-*+]|\d+[.)])\s+', '', text)
    text = re.sub(r'[`*_"“”\']', '', text)
    return re.sub(r'\s+', ' ', text).strip().lower()

def locate_line(path, quote):
    """Find the one line in the file that holds the quoted text. Refuses when it is missing or ambiguous."""
    lines = Path(path).read_text().splitlines(keepends=True)
    wanted = normalize(quote)
    if not wanted: raise RequestRefused('The quote is empty.')
    hits = [i for i, line in enumerate(lines) if wanted in normalize(line)]
    if not hits:
        scored = sorted(((difflib.SequenceMatcher(None, wanted, normalize(line)).ratio(), i) for i, line in enumerate(lines) if line.strip()), reverse=True)
        if scored and scored[0][0] >= FUZZY_MATCH_RATIO: hits = [scored[0][1]]
    if not hits: raise RequestRefused('That exact line is not in the file any more. Open the file to edit it by hand.')
    if len(hits) > 1: raise RequestRefused(f'The text appears on {len(hits)} lines, so the right one is unclear. Edit the file by hand.')
    return hits[0], lines

def rule_path_for(data, finding, quote_file):
    path = str(HOME / quote_file[2:]) if quote_file.startswith('~/') else quote_file
    allowed = {p for i in finding['items'] for t in data['things'] if t['id'] == i and t['kind'] == 'rule' for p in t['paths']}
    if path not in allowed: raise RequestRefused('That file is not one of the rule files in this issue.')
    if not Path(path).is_relative_to(HOME) or not Path(path).is_file(): raise RequestRefused('Only rule files inside your home folder can be edited.')
    return path

def back_up(path):
    BACKUPS.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(BACKUP_MANIFEST.read_text()) if BACKUP_MANIFEST.exists() else {}
    backup_id = datetime.datetime.now().strftime('%Y%m%d-%H%M%S-') + secrets.token_hex(3)
    shutil.copy2(path, BACKUPS / f'{backup_id}.bak')
    manifest[backup_id] = {'path':path, 'at':datetime.datetime.now().astimezone().isoformat(timespec='seconds')}
    BACKUP_MANIFEST.write_text(json.dumps(manifest, indent=2))
    return backup_id

def restore(backup_id):
    manifest = json.loads(BACKUP_MANIFEST.read_text()) if BACKUP_MANIFEST.exists() else {}
    entry = manifest.get(backup_id)
    if not entry or not (BACKUPS / f'{backup_id}.bak').exists(): raise RequestRefused('That backup is gone.')
    shutil.copy2(BACKUPS / f'{backup_id}.bak', entry['path'])
    return entry['path']

def short_path(path): return str(path).replace(str(HOME), '~', 1)

def log_action(kind, **details):
    """Everything changed from the page, with enough detail to understand and restore it later."""
    log = json.loads(ACTIONS.read_text()) if ACTIONS.exists() else []
    log.append({'at':datetime.datetime.now().astimezone().isoformat(timespec='seconds'), 'kind':kind, **details})
    ACTIONS.write_text(json.dumps(log[-ACTIONS_LIMIT:], ensure_ascii=False, indent=2) + '\n')

def fix_files(data, finding):
    quoted = {rule_path_for(data, finding, q['file']) for q in finding.get('quotes', []) if not q.get('removed')}
    if quoted: return sorted(quoted)
    return sorted({p for i in finding['items'] for t in data['things'] if t['id'] == i and t['kind'] == 'rule' for p in t['paths'] if Path(p).is_file()})

def propose_fix(data, finding):
    if finding['kind'] != 'contradiction': raise RequestRefused('AI fixes are available for contradictions.')
    paths = fix_files(data, finding)
    if not paths: raise RequestRefused('No editable rule file found for this issue.')
    quotes = '\n'.join(f"- {q['file']}: {q['text']}" for q in finding.get('quotes', []) if not q.get('removed'))
    files = '\n\n'.join(f'=== {short_path(p)} ===\n{Path(p).read_text()[:FIX_FILE_CHARS]}' for p in paths)
    prompt = f"""Two instructions in these agent rule files contradict each other. Resolve the contradiction with the smallest possible edit.

Contradiction: {finding['title']}
{finding['summary']}
Conflicting lines:
{quotes}
Suggested direction: {finding.get('todo', '')}

{files}

Rules for your answer:
- Prefer rewording one line so both intentions fit. Delete a line only when it is clearly redundant.
- Keep the author's wording, formatting and bullet style. Do not touch anything unrelated.
- Each edit: file (the path exactly as in the === header), find (text copied exactly from that file, whole lines, appearing only once), replace (the new text, or an empty string to delete).
- summary: one plain sentence saying what you changed. Never use em dashes."""
    answer, cost = ask(prompt, FIX_SCHEMA)
    by_short = {short_path(p): p for p in paths}
    edits = []
    for edit in answer.get('edits', []):
        path = by_short.get(edit['file']) or (edit['file'] if edit['file'] in paths else None)
        if not path: raise RequestRefused('The AI suggested editing a file outside this issue. Try again.')
        if not edit['find'] or Path(path).read_text().count(edit['find']) != 1: raise RequestRefused('The AI suggestion did not match the file exactly. Try again.')
        edits.append({'path':path, 'find':edit['find'], 'replace':edit['replace']})
    if not edits: raise RequestRefused('The AI did not suggest any change. Edit the file by hand.')
    if len(PROPOSALS) >= MAX_PROPOSALS: PROPOSALS.pop(next(iter(PROPOSALS)))
    proposal_id = secrets.token_hex(8)
    PROPOSALS[proposal_id] = {'title':finding['title'], 'finding':finding['id'], 'edits':edits, 'summary':answer['summary']}
    return {'proposal':{'id':proposal_id, 'summary':answer['summary'], 'costUsd':round(cost, 3), 'edits':[{'path':short_path(e['path']), 'before':e['find'], 'after':e['replace']} for e in edits]}}

def apply_fix(proposal_id):
    proposal = PROPOSALS.pop(proposal_id, None)
    if not proposal: raise RequestRefused('This suggestion expired. Ask for a new one.')
    for edit in proposal['edits']:
        if Path(edit['path']).read_text().count(edit['find']) != 1: raise RequestRefused('The file changed since the suggestion. Ask for a new one.')
    backups = {}
    for edit in proposal['edits']:
        if edit['path'] not in backups: backups[edit['path']] = back_up(edit['path'])
        text = Path(edit['path']).read_text()
        Path(edit['path']).write_text(text.replace(edit['find'], edit['replace'], 1))
    log_action('ai-fix', title=proposal['title'], summary=proposal.get('summary', ''), edits=[{'file':short_path(e['path']), 'before':e['find'], 'after':e['replace']} for e in proposal['edits']], backups=list(backups.values()))
    resolve = lambda c: {**c, 'resolved':True} if c.get('title') == proposal['title'] else c
    rescan(resolve)
    return {'message':f"Applied the fix to {', '.join(short_path(p) for p in backups)}.", 'undo':list(backups.values()), 'open':proposal['finding']}

# ---- skills and plugins -----------------------------------------------------

def trash_target(thing, path):
    """The folder (for a skill) or file to move. Refuses anything outside the scan or managed by an app or plugin."""
    if thing['kind'] not in REMOVABLE_KINDS: raise RequestRefused(f"{thing['kind']} items cannot be removed from the page.")
    if path not in thing['paths']: raise RequestRefused('That file is not part of this item.')
    if thing.get('plugin'): raise RequestRefused('This comes from a plugin. Disable the plugin instead.')
    if any(marker in path for marker in PROTECTED_MARKERS): raise RequestRefused('This is managed by an app or synced from your account, so it would come back.')
    source = Path(path)
    target = source.parent if thing['kind'] == 'skill' else source
    if not target.is_relative_to(HOME) or target == HOME: raise RequestRefused('Only items inside your home folder can be removed.')
    if not (target.exists() or target.is_symlink()): raise RequestRefused('It is already gone. Reload the page.')
    return target

def move_into_trash_folder(target):
    destination = HOME / '.Trash' / target.name
    if destination.exists() or destination.is_symlink(): destination = destination.with_name(f'{target.name} {secrets.token_hex(3)}')
    # rename moves a symlink itself, never the folder it points to
    target.rename(destination)

def move_to_trash(target):
    """Finder keeps Put Back working for real folders. Links are moved directly so Finder cannot resolve them."""
    if target.is_symlink():
        move_into_trash_folder(target)
        return
    script = 'on run argv\ntell application "Finder" to delete (POSIX file (item 1 of argv) as alias)\nend run'
    result = subprocess.run(['osascript', '-e', script, str(target)], capture_output=True, text=True)
    if result.returncode != 0: move_into_trash_folder(target)

def disable_plugin(thing):
    plugin = thing.get('plugin')
    if not plugin: raise RequestRefused('This item is not part of a plugin.')
    if 'Claude' not in thing['agents']: raise RequestRefused(f'Disable {plugin} in ~/.codex/config.toml by setting enabled = false.')
    claude = shutil.which('claude') or str(CLAUDE_FALLBACK)
    result = subprocess.run([claude, 'plugin', 'disable', plugin, '--scope', 'user'], capture_output=True, text=True, timeout=60)
    if result.returncode != 0: raise RequestRefused(f'Claude Code could not disable {plugin}: {(result.stderr or result.stdout).strip()[:200]}')

# ---- rescan without losing the AI review ------------------------------------

def run_script(name):
    result = subprocess.run([sys.executable, str(BASE / 'scripts' / name)], capture_output=True, text=True, timeout=300)
    if result.returncode != 0: raise OSError(f'{name} failed: {result.stderr.strip()[:300]}')

def rescan(edit_conflict=None):
    """A change gives the affected skill sets and rule stacks new cache keys. Carry the earlier review over,
    apply edit_conflict to each carried contradiction, and mark it so judge.py rechecks those places next time."""
    judgements = load_judgements()
    before = analyze(json.loads(INVENTORY.read_text()), judgements)
    run_script('scan-agent-rules.py')
    after = analyze(json.loads(INVENTORY.read_text()), judgements)
    old_ids_to_new = {}
    keys_after = {k: t['id'] for t in after['things'] for k in t['keys']}
    for t in before['things']:
        new = next((keys_after[k] for k in t['keys'] if k in keys_after), None)
        if new: old_ids_to_new[t['id']] = new
    old_contexts = {(c['agent'], c['project']): c['key'] for c in before['contexts']}
    for ctx in after['contexts']:
        old = judgements['skills'].get(old_contexts.get((ctx['agent'], ctx['project'])))
        if ctx['key'] in judgements['skills'] or not old: continue
        groups = [{**g, 'ids':[old_ids_to_new[i] for i in g['ids'] if i in old_ids_to_new]} for g in old.get('groups', [])]
        judgements['skills'][ctx['key']] = {**old, 'groups':[g for g in groups if len(g['ids']) >= 2], 'carriedOver':True}
    old_stacks = {(s['agent'], s['project']): s['key'] for s in before['stacks']}
    for stack in after['stacks']:
        old = judgements['rules'].get(old_stacks.get((stack['agent'], stack['project'])))
        if stack['key'] in judgements['rules'] or not old: continue
        conflicts = [edit_conflict(dict(c)) if edit_conflict else c for c in old.get('conflicts', [])]
        judgements['rules'][stack['key']] = {**old, 'conflicts':conflicts, 'carriedOver':True}
    JUDGEMENTS.write_text(json.dumps(judgements, ensure_ascii=False, indent=2) + '\n')
    run_script('build.py')

def mark_removed(title, text, backup_id):
    def edit(conflict):
        if conflict.get('title') == title:
            conflict['removed'] = conflict.get('removed', []) + [{'text':text, 'backup':backup_id}]
        return conflict
    return edit

def set_resolved(title, resolved):
    """No file changes here, so the current cache keys stay valid and are edited in place."""
    judgements = load_judgements()
    current = analyze(json.loads(INVENTORY.read_text()), judgements)
    for stack in current['stacks']:
        for conflict in judgements['rules'].get(stack['key'], {}).get('conflicts', []):
            if conflict.get('title') == title: conflict['resolved'] = resolved
    JUDGEMENTS.write_text(json.dumps(judgements, ensure_ascii=False, indent=2) + '\n')
    run_script('build.py')

# ---- HTTP -------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = 'Rulebook'

    def allowed_host(self):
        return self.headers.get('Host', '') in (f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}')

    def send(self, status, body, content_type='application/json'):
        payload = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if not self.allowed_host(): return self.send(403, {'error':'Forbidden host'})
        if self.path.split('?')[0] not in ('/', '/index.html'): return self.send(404, {'error':'Not found'})
        api = f'<script>window.RULEBOOK_API={json.dumps({"token":TOKEN})};</script>'
        self.send(200, INDEX.read_text().replace('</head>', api + '</head>', 1).encode(), 'text/html; charset=utf-8')

    def do_POST(self):
        if not self.allowed_host() or self.headers.get('X-Rulebook-Token') != TOKEN: return self.send(403, {'error':'This page is out of date. Reload it.'})
        length = int(self.headers.get('Content-Length', 0))
        if length > MAX_BODY_BYTES: return self.send(413, {'error':'Request too large'})
        try:
            body = json.loads(self.rfile.read(length) or b'{}')
            if self.path == '/api/propose-fix':
                reply = propose_fix(ui_data(), find_finding(ui_data(), body.get('finding', '')))
            else:
                with CHANGE_LOCK: reply = self.route(body)
        except RequestRefused as exc:
            return self.send(400, {'error':str(exc)})
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
            self.log_error('Change failed: %s', exc)
            return self.send(500, {'error':'That did not work. See the terminal for details.'})
        if reply is None: return self.send(404, {'error':'Not found'})
        self.log_message('%s', reply.get('message', reply))
        self.send(200, {'ok':True, **reply})

    def route(self, body):
        data = ui_data()
        if self.path == '/api/rule-line':
            finding = find_finding(data, body.get('finding', ''))
            quote = (finding.get('quotes') or [])[int(body.get('quote', -1))] if 0 <= int(body.get('quote', -1)) < len(finding.get('quotes') or []) else None
            if not quote: raise RequestRefused('That quote is not part of this issue.')
            path = rule_path_for(data, finding, quote['file'])
            index, lines = locate_line(path, quote['text'])
            preview = {'path':path.replace(str(HOME), '~'), 'lineNumber':index + 1, 'line':lines[index].rstrip('\n')}
            if body.get('dryRun'): return {'preview':preview}
            if body.get('expect') != preview['line']: raise RequestRefused('The file changed since you looked. Try again.')
            backup_id = back_up(path)
            Path(path).write_text(''.join(lines[:index] + lines[index + 1:]))
            log_action('delete-line', title=finding['title'], edits=[{'file':preview['path'], 'before':preview['line'], 'after':''}], backups=[backup_id])
            rescan(mark_removed(finding['title'], quote['text'], backup_id))
            return {'message':f"Deleted line {preview['lineNumber']} from {preview['path']}. Delete more lines or mark it resolved.", 'undo':backup_id, 'open':finding['id']}
        if self.path == '/api/apply-fix':
            return apply_fix(body.get('proposal', ''))
        if self.path == '/api/resolve':
            resolved = bool(body.get('resolved', True))
            if resolved:
                title = find_finding(data, body.get('finding', ''))['title']
            else:
                title = body.get('title', '')
                if not any(c.get('title') == title and c.get('resolved') for v in load_judgements()['rules'].values() for c in v.get('conflicts', [])): raise RequestRefused('Nothing to bring back.')
            set_resolved(title, resolved)
            log_action('resolve' if resolved else 'unresolve', title=title)
            return {'message':'Marked as resolved.' if resolved else 'Back on the list.', 'undoResolve':title if resolved else None, 'open':body.get('finding') if not resolved else None}
        if self.path == '/api/undo':
            backups = body.get('backups') or [body.get('backup', '')]
            paths = [restore(b) for b in backups]
            log_action('restore', files=[short_path(p) for p in paths], backups=backups)
            rescan()
            return {'message':f"Restored {', '.join(short_path(p) for p in paths)}.", 'open':body.get('open')}
        if self.path == '/api/trash':
            target = trash_target(find_thing(data, body.get('id', '')), body.get('path', ''))
            move_to_trash(target)
            log_action('trash', name=target.name, files=[short_path(target)])
            rescan()
            return {'message':f'Moved {target.name} to the Trash. Use Put Back in Finder to restore it.'}
        if self.path == '/api/disable-plugin':
            thing = find_thing(data, body.get('id', ''))
            disable_plugin(thing)
            log_action('disable-plugin', name=thing['plugin'])
            rescan()
            return {'message':f"Disabled the {thing['plugin'].split('@')[0]} plugin. New Claude Code sessions will not load it."}
        return None

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=DEFAULT_PORT)
    parser.add_argument('--no-open', action='store_true', help='Do not open the browser')
    args = parser.parse_args()
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    url = f'http://127.0.0.1:{args.port}/'
    print(f'Rulebook running at {url}  (Ctrl+C to stop)')
    if not args.no_open: webbrowser.open(url)
    try: server.serve_forever()
    except KeyboardInterrupt: print('\nStopped.')

if __name__ == '__main__': main()
