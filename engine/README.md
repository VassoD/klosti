# agent-rulebook

See every rule, skill, hook and MCP server your coding agents (Claude Code, Codex, Cursor, Gemini) use, where each one applies, and what overlaps or contradicts. Fix contradictions in place, with backups and undo.

```sh
npx agent-rulebook            # scan, then open the app in your browser
npx agent-rulebook scan       # scan and print a summary
npx agent-rulebook review     # AI review of overlaps and contradictions
npx agent-rulebook build -o rulebook.html   # standalone page
```

Requires Node 20 or later. Everything runs locally. The scanner never copies MCP environment variables, headers or arguments, and masks anything that looks like a credential in hook commands.

## What it scans

Common code folders in your home (`side-projects`, `projects`, `code`, `dev`, `Developer`, `repos`, `Documents` and others that exist) plus agent settings folders (`~/.claude`, `~/.codex`, `~/.agents`, `~/.cursor`, `~/.gemini`). Add or replace folders in `~/.config/agent-rulebook/config.json`:

```json
{ "roots": ["~/work/clients"], "replaceDefaultRoots": false, "exclude": ["fixtures"] }
```

Or pass `--root DIR` (repeatable) for a one-off scan.

## AI features

The review and "Fix with AI" use your local Claude Code (`claude -p`, with no settings, plugins, hooks, MCP servers or tools loaded) when it is installed, and otherwise the Anthropic API with `ANTHROPIC_API_KEY`. The default model is `claude-opus-5-5`; set `AGENT_RULEBOOK_MODEL` to change it, for example `claude-sonnet-5-5` for lower cost. Results are cached by content, so only new or changed places are reviewed.

## Data

Kept in one folder, never next to your code: `~/Library/Application Support/agent-rulebook` on macOS, `~/.local/share/agent-rulebook` on Linux, `%APPDATA%\agent-rulebook` on Windows. Override with `--data DIR` or `AGENT_RULEBOOK_DATA`. Rule edits are backed up in `backups/` there before any change.

## Development

```sh
npm install
npm test        # build, then run the tests
```
