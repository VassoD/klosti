interface LogoProps {
  size?: number;
}

export function Logo({ size = 30 }: LogoProps): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <mask id="logo-cut">
        <rect width="64" height="64" fill="#fff" />
        <path d="M28 26.5C34 30 46 32 56 28" fill="none" stroke="#000" strokeWidth="10.5" strokeLinecap="round" />
      </mask>
      <g fill="none" stroke="var(--clay)" strokeWidth="6.5" strokeLinecap="round">
        <path d="M8 48C18 48 26 40 32 30C37 22 42 13 34 12C25 11 22 23 28 26.5" mask="url(#logo-cut)" />
        <path d="M28 26.5C34 30 46 32 56 28" />
      </g>
    </svg>
  );
}
