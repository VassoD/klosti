/** The published .dmg, for example a GitHub release. Until it is set, the site leads with the CLI and hides the Mac download. */
export const MAC_DOWNLOAD_URL: string | null = process.env.NEXT_PUBLIC_MAC_DOWNLOAD_URL || null;

export const DOWNLOAD_PAGE = "/download";

export const CLI_COMMAND = "npx klosti";

export const STORY_POST_URL = "https://www.vassi.fyi/writing/what-was-the-agent-told";
export const GUIDE_POST_URL = "https://www.vassi.fyi/writing/how-to-know-your-harness";

export const PLATFORM_NOTE = "For macOS 11 or later, on Macs with Apple silicon";

export const CLI_NOTE = "Runs locally on macOS, Linux and Windows. Requires Node 20 or later.";

/** Installs the menu bar app from the latest GitHub release. Running it again updates the app. */
export const MAC_INSTALL_COMMAND = "curl -fsSL https://klosti.vassi.fyi/install.sh | sh";
