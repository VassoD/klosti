const AGENT_FILES = [
  { agent: "Claude Code", files: "~/.claude/CLAUDE.md, ./CLAUDE.md, .claude/skills/*/SKILL.md, settings.json hooks, ~/.claude.json" },
  { agent: "Codex", files: "~/.codex/AGENTS.md, ./AGENTS.md, ~/.codex/config.toml" },
  { agent: "Cursor", files: ".cursor/rules/*.mdc, ~/.cursor/mcp.json" },
  { agent: "Gemini", files: "~/.gemini/GEMINI.md, ./GEMINI.md, settings.json" },
  { agent: "Plugins and skill packs", files: "skills, commands, subagents, hooks.json, .mcp.json, skills-lock.json" },
] as const;

export function Story(): React.JSX.Element {
  return (
    <section id="story" className="story">
      <div className="prose">
        <p className="kicker">Why the name</p>
        <h2>Ariadne&apos;s thread</h2>
        <p>
          In the myth, Theseus walks into the labyrinth at Knossos holding a ball of thread from Ariadne. He unwinds it as
          he goes, and follows it back out.
        </p>
        <p>
          Your agent setup is a labyrinth of its own. A global CLAUDE.md, an AGENTS.md in every repo, Cursor rules, skills
          copied in from three places, plugins that bring their own hooks. Each file made sense the day you wrote it.
          Together, it&apos;s hard to say which instruction wins.
        </p>
        <p>
          klosti is the thread. It follows every file each agent loads, in the order it loads them, so you can find your
          way back out.
        </p>
      </div>
      <aside className="tangle" aria-label="Where your agents look for instructions">
        <h3>The labyrinth, on a typical Mac</h3>
        <dl>
          {AGENT_FILES.map(({ agent, files }) => (
            <div key={agent}>
              <dt>{agent}</dt>
              <dd>{files}</dd>
            </div>
          ))}
        </dl>
        <p className="foot">klosti scans your code folders and every agent&apos;s settings folder, then puts it all on one page.</p>
      </aside>
    </section>
  );
}
