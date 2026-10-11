#!/usr/bin/env python3
"""Install (or remove with --uninstall) a launchd agent that rescans with the TypeScript engine when skills change."""
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys

BASE = Path(__file__).resolve().parents[1]
HOME = Path.home()
LABEL = 'local.agent-rulebook.refresh'
PLIST = HOME / 'Library/LaunchAgents' / f'{LABEL}.plist'
LOG = HOME / 'Library/Logs/agent-rulebook.log'
# Folders where installs land. launchd fires when their direct entries change.
WATCHED = ['.claude/skills', '.claude/plugins', '.codex/skills', '.codex/config.toml', '.agents/skills', '.cursor/skills-cursor']
# Project skills live deep in repos, which launchd cannot watch recursively, so a periodic scan catches them.
PERIODIC_SECONDS = 3 * 60 * 60
THROTTLE_SECONDS = 120
NODE = shutil.which('node') or str(HOME / '.local/bin/node')

def launchctl(*args):
    return subprocess.run(['launchctl', *args], capture_output=True, text=True)

def uninstall():
    launchctl('bootout', f'gui/{os.getuid()}/{LABEL}')
    PLIST.unlink(missing_ok=True)
    print(f'Removed {PLIST}')

def install():
    watched = [str(HOME / p) for p in WATCHED if (HOME / p).exists()]
    config = {
        'Label': LABEL,
        'ProgramArguments': [NODE, str(BASE / 'engine/dist/src/cli.js'), 'scan', '--notify'],
        'WorkingDirectory': str(BASE),
        'WatchPaths': watched,
        'StartInterval': PERIODIC_SECONDS,
        'ThrottleInterval': THROTTLE_SECONDS,
        'RunAtLoad': True,
        'LowPriorityIO': True,
        'ProcessType': 'Background',
        'StandardOutPath': str(LOG),
        'StandardErrorPath': str(LOG),
    }
    PLIST.parent.mkdir(parents=True, exist_ok=True)
    launchctl('bootout', f'gui/{os.getuid()}/{LABEL}')
    PLIST.write_bytes(plistlib.dumps(config))
    result = launchctl('bootstrap', f'gui/{os.getuid()}', str(PLIST))
    if result.returncode != 0: sys.exit(f'launchctl bootstrap failed: {result.stderr.strip()}')
    print(f'Installed {PLIST}\nWatching: {", ".join(watched)}\nAlso rescans every {PERIODIC_SECONDS // 3600} hours. Log: {LOG}')

if __name__ == '__main__': uninstall() if '--uninstall' in sys.argv else install()
