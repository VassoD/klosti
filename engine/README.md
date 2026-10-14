# klosti

See every rule, skill, hook and MCP server your coding agents (Claude Code, Codex, Cursor, Gemini) use, where each one applies, and what overlaps or contradicts. Fix contradictions in place, with backups and undo.

```sh
npx klosti            # scan, then open the app in your browser
npx klosti scan       # scan and print a summary
npx klosti review     # AI review of overlaps and contradictions
npx klosti build -o klosti.html   # standalone page
```

Requires Node 20 or later. Everything runs locally. The scanner never copies MCP environment variables, headers or arguments, and masks anything that looks like a credential in hook commands. For skill history it reads Claude Code's session logs in `~/.claude/projects`, keeping only skill names, dates, the project folder and the paths of files written or edited, never the conversation.

## What it scans

Common code folders in your home (`side-projects`, `projects`, `code`, `dev`, `Developer`, `repos`, `Documents` and others that exist) plus agent settings folders (`~/.claude`, `~/.codex`, `~/.agents`, `~/.cursor`, `~/.gemini`). Add or replace folders in `~/.config/klosti/config.json`:

```json
{ "roots": ["~/work/clients"], "replaceDefaultRoots": false, "exclude": ["fixtures"], "ignore": ["~/side-projects/old-repo"] }
```

`exclude` skips folders with that name anywhere; `ignore` skips specific folders. The app manages `ignore` for you: "Stop scanning this project" in Where things apply, or Folders you ignore under Changes.

Or pass `--root DIR` (repeatable) for a one-off scan.

## AI features

The review and "Fix with AI" run through one of your installed tools: Claude Code (`claude -p`, with no settings, plugins, hooks, MCP servers or tools loaded), Codex (`codex exec` in a read-only sandbox, without your `config.toml`), Mistral Vibe (`vibe -p` with every tool turned off), or the Anthropic API with `ANTHROPIC_API_KEY`. Pick one in Settings; otherwise the first one found is used, in that order. Each runs in an empty temporary folder, and Klosti applies any edit itself, with a backup. With Claude the default model is `claude-opus-5-5`; set `KLOSTI_MODEL` to change it, for example `claude-sonnet-5-5` for lower cost. Codex and Vibe use their own default model. Vibe cannot enforce an answer format, so its replies are checked and retried when malformed. The review checks skills for duplicates and overlaps, rule files for contradictions, and skills against your rules and each other: it first quotes the behaviour instructions in each SKILL.md, then looks for any that clash with a rule or another skill loaded in the same place. Results are cached by content, so only new or changed places and skills are reviewed. `klosti review --dry-run` shows how many calls and tokens a review would use.

## Data

Kept in one folder, never next to your code: `~/Library/Application Support/klosti` on macOS, `~/.local/share/klosti` on Linux, `%APPDATA%\klosti` on Windows. Override with `--data DIR` or `KLOSTI_DATA`. An existing `agent-rulebook` folder from before the rename is still used when no `klosti` folder exists, and the old `AGENT_RULEBOOK_*` variables still work. Rule edits are backed up in `backups/` there before any change.

## Development

```sh
npm install
npm test        # build, then run the tests
```
