const PROMISES = [
  { title: "Local by default", body: "Scanning, the map and applying fixes all run on your machine. Nothing is uploaded unless you ask for the AI." },
  {
    title: "AI only when you ask",
    body: "Reviews and \"Fix with AI\" send the text of your rule files, skills and memories through an agent you already use: Claude Code, Codex or Mistral Vibe, or your Anthropic API key. Klosti asks before it sends anything the first time, and you can stop it in Settings.",
  },
  {
    title: "Secrets left behind",
    body: "MCP entries keep only the server name, transport and host. Anything in a hook command that looks like a credential is masked.",
  },
  {
    title: "One data folder",
    body: "Everything Klosti keeps lives in one folder, never next to your code, along with a backup of every edit.",
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
