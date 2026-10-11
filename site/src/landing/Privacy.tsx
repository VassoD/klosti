const PROMISES = [
  { title: "Local by default", body: "Scanning, the map and the fixes all run on your machine. Nothing is uploaded." },
  { title: "AI only when you ask", body: "Reviews and \"Fix with AI\" go to Claude through your own Claude Code, or your Anthropic API key." },
  {
    title: "Secrets left behind",
    body: "MCP entries keep only the server name, transport and host. Anything in a hook command that looks like a credential is masked.",
  },
  {
    title: "One data folder",
    body: "Everything klosti keeps lives in one folder, never next to your code, along with a backup of every edit.",
  },
] as const;

export function Privacy(): React.JSX.Element {
  return (
    <section id="privacy" className="privacy">
      <p className="kicker">Privacy</p>
      <h2>Stays on your Mac</h2>
      <ul>
        {PROMISES.map(({ title, body }) => (
          <li key={title}>
            <b>{title}</b>
            {body}
          </li>
        ))}
      </ul>
    </section>
  );
}
