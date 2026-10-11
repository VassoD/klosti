import { CopyCommand } from "@/landing/CopyCommand";
import { DownloadButton } from "@/landing/DownloadButton";
import { CLI_COMMAND, PLATFORM_NOTE } from "@/landing/links";

export function Install(): React.JSX.Element {
  return (
    <section id="install" className="install">
      <p className="kicker">Install</p>
      <h2>Pick up the thread</h2>
      <p className="install-lead">
        klosti lives in your menu bar, keeps watch in the background, and lets you know when your agent setup changes.
      </p>
      <DownloadButton />
      <p className="fine">{PLATFORM_NOTE}</p>
      <div className="cli-alt">
        <span>On Linux or Windows, or prefer the terminal?</span>
        <CopyCommand command={CLI_COMMAND} />
      </div>
    </section>
  );
}
