export function ExampleFinding(): React.JSX.Element {
  return (
    <figure className="finding-wrap">
      <article className="finding" aria-label="Example finding">
        <header>
          <span className="dot" aria-hidden="true" />
          <div>
            <div className="label">Act on these · Claude Code</div>
            <h4>Two rule files disagree about exports</h4>
          </div>
        </header>
        <div className="body">
          <p>
            Your global rules ask for named exports. The project rules in <code>web/</code> ask for default exports on
            pages. Claude Code loads both there, so it gets both instructions and has to guess.
          </p>
        </div>
        <div className="diff">
          <span className="path">~/side-projects/web/CLAUDE.md</span>
          <pre className="old">- Export every page component as default.</pre>
          <pre className="new">- Export page components as default (Next.js requires it). Everything else uses named exports.</pre>
        </div>
        <footer>
          <span className="chip primary">Apply fix</span>
          <span className="chip">Fix with AI</span>
          <span className="chip">Ignore</span>
        </footer>
      </article>
      <figcaption>An example finding, as it appears in the app.</figcaption>
    </figure>
  );
}
