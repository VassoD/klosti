# Agent Rulebook

A local page that shows what your coding agents (Claude Code, Codex, Cursor, Gemini) can use on this Mac, where each thing applies, and where things overlap or contradict. Open `index.html`.

- **Overview**: clashes that need a decision, with what happens today and what to do.
- **Where things apply**: pick an agent and a project to see exactly what loads there: rules in load order, skills, hooks, MCP servers, subagents.
- **Everything installed**: skills, rules, commands, subagents, hooks and MCP servers, grouped by origin (plugin, skill pack such as Superpowers, claude.ai, project).
- **What's what**: what each kind of thing is, and who wins when two collide, based on the Claude Code and Codex docs.
- **Changes**: what was added, updated or removed since tracking started.

## Remove things from the page

```sh
python3 scripts/serve.py
```

This opens the page at `http://127.0.0.1:4711`.

**Fix a contradiction**: open it on the Overview and click **Delete this line** next to the side you don't want. The page shows the exact line it found, and deletes it only after you confirm. The file is backed up to `data/backups/` first, and **Undo** restores it. The other findings are kept and marked for a recheck by `judge.py`.

**Remove a skill**: open any skill, command or subagent to get a **Move to Trash** button (click twice to confirm). It moves the folder to the macOS Trash, so Finder's Put Back restores it, then rescans. Removing a symlinked copy removes only the link. Plugin skills offer **Disable plugin** instead, because a single plugin skill would come back on the next update. Skills synced from claude.ai and skills built into an app cannot be removed here. The server only listens on localhost, needs a token embedded in the page, and only acts on items from the last scan.

Findings you don't care about can be dismissed from the Overview. Dismissals are remembered in your browser.

## Refresh

```sh
python3 scripts/refresh.py      # scan and rebuild, free
python3 scripts/judge.py        # AI review of overlaps and contradictions
```

`refresh.py` runs `scan-agent-rules.py` (read-only inventory) and `build.py` (analysis plus page). It needs Python 3.11 or later.

`judge.py` asks your local Claude Code (`claude -p`, Sonnet) to review each place where skills or rules load together. The headless session loads no settings, plugins, hooks, MCP servers or tools. Results are cached by content in `data/judgements.json`, so later runs only review what changed. It uses your Claude Code account: plan usage on a subscription, or API billing with an API key. The first full run reported about $1 at list price. Use `--dry-run` to see what would be reviewed.

## Stay up to date

```sh
python3 scripts/install-watcher.py              # install
python3 scripts/install-watcher.py --uninstall  # remove
```

A launchd agent runs `refresh.py` when your skill or plugin folders change and every 3 hours, and posts a macOS notification when something was added, updated or removed. It does not run the AI review. Log: `~/Library/Logs/agent-rulebook.log`.

## Privacy

Everything stays on this Mac except what `judge.py` sends to Claude. `index.html` and `data/` contain your instruction text, so review them before sharing. MCP entries keep only the server name, transport and host; environment variables, headers and arguments are never copied. Hook commands are shown with anything that looks like a credential masked.

## Limits

Agent tags come from file locations, imports and the documented loading rules. Finding a file does not prove a session loaded it. Account connectors (claude.ai, ChatGPT) are not stored on disk and are not listed.
