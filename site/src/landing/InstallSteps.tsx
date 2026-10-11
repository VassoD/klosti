import { Logo } from "@/landing/Logo";

function DiskImageArt(): React.JSX.Element {
  return (
    <svg viewBox="0 0 120 80" aria-hidden="true">
      <rect x="10" y="8" width="100" height="64" rx="8" className="art-window" />
      <path d="M10 22h100" className="art-line" />
      <circle cx="20" cy="15" r="2.5" className="art-dot" />
      <circle cx="28" cy="15" r="2.5" className="art-dot" />
      <circle cx="36" cy="15" r="2.5" className="art-dot" />
      <rect x="44" y="32" width="32" height="30" rx="5" className="art-file" />
      <text x="60" y="52" textAnchor="middle" className="art-label">.dmg</text>
    </svg>
  );
}

function DragArt(): React.JSX.Element {
  return (
    <svg viewBox="0 0 120 80" aria-hidden="true">
      <rect x="10" y="8" width="100" height="64" rx="8" className="art-window" />
      <g transform="translate(16 24) scale(0.5)">
        <path d="M8 48C18 48 26 40 32 30C37 22 42 13 34 12C25 11 22 23 28 26.5M28 26.5C34 30 46 32 56 28" className="art-thread" />
      </g>
      <path d="M52 40h18m-6-6 6 6-6 6" className="art-arrow" />
      <path d="M78 30h10l4 4h10v20H78z" className="art-folder" />
    </svg>
  );
}

function OpenArt(): React.JSX.Element {
  return (
    <svg viewBox="0 0 120 80" aria-hidden="true">
      <rect x="10" y="8" width="100" height="64" rx="8" className="art-window" />
      <path d="M10 22h100" className="art-line" />
      <rect x="20" y="30" width="24" height="16" rx="3" className="art-file" />
      <rect x="48" y="30" width="24" height="16" rx="3" className="art-file art-selected" />
      <rect x="76" y="30" width="24" height="16" rx="3" className="art-file" />
      <text x="60" y="58" textAnchor="middle" className="art-label">Klosti</text>
    </svg>
  );
}

const STEPS = [
  { art: <DiskImageArt />, text: "Open Klosti.dmg from your Downloads folder" },
  { art: <DragArt />, text: "Drag the Klosti icon into your Applications folder" },
  { art: <OpenArt />, text: "Open Klosti from your Applications folder" },
] as const;

export function InstallSteps(): React.JSX.Element {
  return (
    <>
      <ol className="steps">
        {STEPS.map(({ art, text }, index) => (
          <li key={text}>
            <span className="step-n">{index + 1}</span>
            <div className="step-art">{art}</div>
            <p>{text}</p>
          </li>
        ))}
      </ol>
      <p className="gatekeeper">
        <Logo size={20} />
        <span>
          If macOS says it can&apos;t check Klosti for malicious software, open <b>System Settings</b>, go to{" "}
          <b>Privacy &amp; Security</b>, and click <b>Open Anyway</b>. You only need to do this once.
        </span>
      </p>
    </>
  );
}
