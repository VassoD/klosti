import { CopyCommand } from "@/landing/CopyCommand";
import { GetKlosti } from "@/landing/GetKlosti";
import { CLI_COMMAND, MAC_DOWNLOAD_URL } from "@/landing/links";

export function Install(): React.JSX.Element {
  return (
    <section id="install" className="install">
      <p className="kicker">Install</p>
      <h2>Pick up the thread</h2>
      <p className="install-lead">
        {MAC_DOWNLOAD_URL
          ? "Klosti lives in your menu bar, keeps watch in the background, and lets you know when your agent setup changes."
          : "One command scans your setup and opens Klosti in your browser. Nothing to install, and nothing leaves your machine."}
      </p>
      <GetKlosti />
      {MAC_DOWNLOAD_URL && (
        <div className="cli-alt">
          <span>On Linux or Windows, or prefer the terminal?</span>
          <CopyCommand command={CLI_COMMAND} />
        </div>
      )}
    </section>
  );
}
