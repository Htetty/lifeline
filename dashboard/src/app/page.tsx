import Link from "next/link";

export default function Home() {
  return (
    <main className="landing">
      <nav className="landing-nav" aria-label="Main navigation">
        <Link href="/" className="brand">Lifeline</Link>
        <div><a href="#how">How it works</a><Link className="button button-light" href="/console">Open dispatcher console <span>↗</span></Link></div>
      </nav>
      <section className="hero">
        <div>
          <p className="eyebrow"><i className="live-dot" /> Flood response · Call overflow</p>
          <h1>When the lines flood, no caller gets a busy signal.</h1>
          <p className="hero-copy">Lifeline’s AI voice agent collects location, people and hazards, and puts a report on the dispatcher’s live map. Dispatchers send the teams. The AI takes the notes.</p>
          <div className="hero-actions"><Link className="button button-blue" href="/console">Open dispatcher console <span>↗</span></Link></div>
          <p className="prototype-note">A flood-response prototype. Fictional exercises only.</p>
        </div>
        <article className="intake-preview" id="intake" aria-label="Illustrative call intake">
          <header><span><i className="live-dot" /> AI call intake</span><span className="mono muted">EXAMPLE</span><div className="waveform" aria-hidden="true">{[10, 20, 13, 27, 18, 30, 14, 23, 10].map((h, i) => <i key={i} style={{ height: h, animationDelay: `${i * -0.13}s`, animationDuration: `${0.8 + (i % 3) * 0.2}s` }} />)}</div></header>
          <div className="transcript-preview">
            <p><span>CALLER</span>We’re upstairs. The water is rising on the stairs. There are three of us.</p>
            <p><span>AI</span>What’s the address, or the nearest cross street?</p>
            <p><span>CALLER</span>123 Hotel Circle South, in Mission Valley.</p>
          </div>
          <footer><p className="eyebrow">Extracted → dispatcher review</p><div className="preview-tags"><span className="tag-warning">Rising water</span><span>123 Hotel Circle South</span><span>3 people · upstairs</span><span>Location needs confirmation</span></div></footer>
          <div className="preview-caption"><span className="live-dot" /> Caller facts first. Human decisions always.</div>
        </article>
      </section>
      <section className="how-section" id="how" aria-label="How it works">
        {[
          ["01", "Capture the call", "The voice bridge collects the caller’s words and asks follow-up questions about their location, people and hazards."],
          ["02", "Bring the facts together", "Reports appear on the live map alongside simulated flood depth, incident priorities and available rescue teams."],
          ["03", "Keep dispatchers in command", "A dispatcher confirms the location and approves a team. Confirmed updates are then spoken back to the caller."],
        ].map(([number, title, text]) => <article key={number}><span className="eyebrow">{number}</span><h2>{title}</h2><p>{text}</p></article>)}
      </section>
      <section className="pipeline-section" id="pipeline"><p className="eyebrow muted">One call, end to end</p><div>{["Caller", "Speech to text", "Fact extraction", "Live flood map", "Dispatcher approval", "Spoken update"].map((step, i) => <div key={step}>{i > 0 && <span aria-hidden="true">→</span>}<span className={i === 4 ? "pipeline-step highlighted" : "pipeline-step"}>{step}</span></div>)}</div></section>
      <footer className="landing-footer"><span>Lifeline <span className="muted">: A flood-response prototype</span></span><span>Cartesia · Claude · Convex · MapLibre</span></footer>
    </main>
  );
}
