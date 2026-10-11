#!/usr/bin/env python3
"""Rescan, rebuild index.html, and post a macOS notification when skills were added, updated or removed."""
import datetime
import fcntl
import json
from pathlib import Path
import subprocess
import sys

BASE = Path(__file__).resolve().parents[1]
LOCK_FILE = BASE / 'data/.refresh.lock'
NOTIFY_NAME_LIMIT = 3
NOTIFICATION_TITLE = 'Agent Rulebook'

def run(script):
    result = subprocess.run([sys.executable, str(BASE / 'scripts' / script)], capture_output=True, text=True, cwd=BASE)
    if result.returncode != 0: raise RuntimeError(f'{script} failed: {result.stderr.strip()}')
    return result.stdout

def describe(label, items):
    names = [i['name'] for i in items]
    shown = ', '.join(names[:NOTIFY_NAME_LIMIT]) + (f' +{len(names) - NOTIFY_NAME_LIMIT}' if len(names) > NOTIFY_NAME_LIMIT else '')
    return f'{len(names)} {label}: {shown}'

def notify(summary):
    parts = [describe(label, summary[key]) for key, label in [('added', 'new'), ('changed', 'updated'), ('removed', 'removed')] if summary[key]]
    if not parts: return
    message = ' · '.join(parts)
    # Pass text as arguments so skill names never need AppleScript escaping.
    script = 'on run argv\ndisplay notification (item 1 of argv) with title (item 2 of argv) subtitle "Skills changed"\nend run'
    subprocess.run(['osascript', '-e', script, message, NOTIFICATION_TITLE], check=False)

def main():
    LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(LOCK_FILE, 'w') as lock:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('Another refresh is running; skipping.')
            return
        stamp = datetime.datetime.now().astimezone().isoformat(timespec='seconds')
        try:
            summary = json.loads(run('scan-agent-rules.py'))
            built = run('build.py').strip()
        except (RuntimeError, ValueError) as exc:
            print(json.dumps({'at':stamp, 'error':str(exc)}))
            sys.exit(1)
        print(json.dumps({'at':stamp, 'skills':summary['skills'], 'added':len(summary['added']), 'changed':len(summary['changed']), 'removed':len(summary['removed']), 'errors':summary['scanErrors'], 'build':built}))
        if '--quiet' not in sys.argv: notify(summary)

if __name__ == '__main__': main()
