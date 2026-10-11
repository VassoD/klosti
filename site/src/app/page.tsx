import { Features } from "@/landing/Features";
import { Hero } from "@/landing/Hero";
import { Install } from "@/landing/Install";
import { Privacy } from "@/landing/Privacy";
import { SiteFooter } from "@/landing/SiteFooter";
import { SiteHeader } from "@/landing/SiteHeader";
import { Story } from "@/landing/Story";
import { ThreadMaze } from "@/landing/ThreadMaze";

export default function HomePage(): React.JSX.Element {
  return (
    <>
      <SiteHeader />
      <Hero />
      <ThreadMaze />
      <main className="wrap">
        <Story />
        <Features />
        <Privacy />
        <Install />
        <SiteFooter />
      </main>
    </>
  );
}
