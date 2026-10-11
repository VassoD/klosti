import { ExampleFinding } from "@/landing/ExampleFinding";

const FEATURES = [
  {
    title: "What each agent sees, per project",
    body: "Pick an agent and a folder. Klosti lists the rule files that load there in order, the skills the agent can reach for, the hooks that will run and the MCP servers it can call.",
  },
  {
    title: "Clashes, ranked",
    body: "Duplicate skills, rules that say opposite things, skill lists too long for the context window. Each finding says what happens today and what you can do, sorted into Act on these, Worth checking and For your information. Claude can review the overlaps, and only rechecks what changed.",
  },
  {
    title: "Fixes you can undo",
    body: "Accept a fix and Klosti edits the file in place. Every edit is backed up first, and one click puts it back.",
  },
  {
    title: "Notices when things change",
    body: "The Mac app lives in your menu bar and rescans when your skill or plugin folders change, and every 3 hours. A timeline keeps your fixes, new installs and edits made by hand.",
  },
] as const;

export function Features(): React.JSX.Element {
  return (
    <section id="what" className="features">
      <div>
        <p className="kicker">What it shows</p>
        <h2>Every turn of the maze, on one page</h2>
        <div className="flist">
          {FEATURES.map(({ title, body }) => (
            <div className="feat" key={title}>
              <h3>{title}</h3>
              <p>{body}</p>
            </div>
          ))}
        </div>
      </div>
      <ExampleFinding />
    </section>
  );
}
