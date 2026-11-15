import { GetKlosti } from "@/landing/GetKlosti";

export function Hero(): React.JSX.Element {
  return (
    <div className="wrap hero" id="top">
      <p className="eyebrow">
        <b lang="el">κλωστή</b> Greek for thread
      </p>
      <h1>
        A <em>thread</em> through your agent setup.
      </h1>
      <p className="lead">
        For people who work across many projects and agents. Claude Code, Codex, Cursor and Gemini each read their own
        rules, skills, hooks and MCP servers, from folders all over your machine. Klosti maps all of it, shows what each
        agent is actually told in each project, and tells you where your instructions contradict each other.
      </p>
      <GetKlosti />
    </div>
  );
}
