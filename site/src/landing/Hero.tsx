import { DownloadButton } from "@/landing/DownloadButton";
import { PLATFORM_NOTE } from "@/landing/links";

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
        Claude Code, Codex, Cursor and Gemini each read their own rules, skills, hooks and MCP servers, from folders all
        over your Mac. Klosti maps all of it, shows what each agent sees in each project, and tells you where your
        instructions contradict each other.
      </p>
      <div className="ctas">
        <DownloadButton />
      </div>
      <p className="fine">{PLATFORM_NOTE}</p>
    </div>
  );
}
