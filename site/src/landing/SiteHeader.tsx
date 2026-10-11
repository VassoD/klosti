import { Logo } from "@/landing/Logo";

const NAV_LINKS = [
  { href: "/#story", label: "The name" },
  { href: "/#what", label: "What it shows" },
  { href: "/#privacy", label: "Privacy" },
  { href: "/#install", label: "Install" },
] as const;

export function SiteHeader(): React.JSX.Element {
  return (
    <header className="wrap top">
      <a className="brand" href="/">
        <Logo />
        klosti
      </a>
      <nav aria-label="Page">
        {NAV_LINKS.map(({ href, label }) => (
          <a key={href} href={href}>
            {label}
          </a>
        ))}
      </nav>
    </header>
  );
}
