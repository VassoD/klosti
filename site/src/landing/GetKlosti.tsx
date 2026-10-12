import { CopyCommand } from "@/landing/CopyCommand";
import { DownloadButton } from "@/landing/DownloadButton";
import { CLI_COMMAND, CLI_NOTE, MAC_DOWNLOAD_URL, PLATFORM_NOTE } from "@/landing/links";

/** The main way to get Klosti: the Mac app once it is published, the CLI until then. */
export function GetKlosti(): React.JSX.Element {
  if (MAC_DOWNLOAD_URL) {
    return (
      <>
        <div className="ctas">
          <DownloadButton />
        </div>
        <p className="fine">{PLATFORM_NOTE}</p>
      </>
    );
  }
  return (
    <>
      <div className="ctas">
        <CopyCommand command={CLI_COMMAND} />
      </div>
      <p className="fine">{CLI_NOTE}</p>
    </>
  );
}
