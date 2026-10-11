#!/usr/bin/env python3
"""Combine the inventory and the cached AI review into index.html."""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from analyze import analyze  # noqa: E402

BASE = Path(__file__).resolve().parents[1]
INVENTORY = BASE / 'data/agent-rules-inventory.json'
JUDGEMENTS = BASE / 'data/judgements.json'
ACTIONS = BASE / 'data/actions.json'

def main():
    data = json.loads(INVENTORY.read_text())
    judgements = json.loads(JUDGEMENTS.read_text()) if JUDGEMENTS.exists() else {}
    result = analyze(data, judgements)
    fresh = lambda group, key: key in judgements.get(group, {}) and not judgements[group][key].get('carriedOver')
    reviewed = [c for c in result['contexts'] if fresh('skills', c['key'])] + [s for s in result['stacks'] if fresh('rules', s['key'])]
    review_dates = [v['at'] for group in ('skills', 'rules') for v in judgements.get(group, {}).values()]
    payload = {
        'things':result['things'], 'projects':result['projects'], 'findings':result['findings'], 'budgets':result['budgets'],
        'review':{'done':len(reviewed), 'total':len(result['contexts']) + len(result['stacks']), 'lastAt':max(review_dates, default=None)},
        'history':data.get('history', []), 'actions':json.loads(ACTIONS.read_text()) if ACTIONS.exists() else [], 'plugins':data.get('plugins', []), 'memories':data.get('memories', []),
        'scannedAt':data['scannedAt'], 'baselineAt':data.get('baselineAt', data['scannedAt']), 'roots':data['roots'], 'excluded':data['excluded'], 'limits':data['limits'], 'errors':data['errors'],
    }
    html = (BASE / 'src/template.html').read_text().replace('__DATA__', json.dumps(payload, ensure_ascii=False).replace('<', '\\u003c'))
    (BASE / 'index.html').write_text(html)
    (BASE / 'data/ui-data.json').write_text(json.dumps(payload))
    kinds = {}
    for t in result['things']: kinds[t['kind']] = kinds.get(t['kind'], 0) + 1
    print(f"Built {', '.join(f'{v} {k}s' for k, v in kinds.items())}; {len(result['findings'])} findings; AI review {payload['review']['done']}/{payload['review']['total']}.")

if __name__ == '__main__': main()
