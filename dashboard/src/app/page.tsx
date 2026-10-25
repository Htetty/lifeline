import Link from "next/link";
import LandingMap from "@/components/LandingMap";

function MapPreview() {
  return (
    <article className="map-preview" aria-label="Illustrative dispatcher map">
      <header>
        <span><i className="live-dot" /> Live flood map</span>
        <span className="mono muted">EXAMPLE</span>
      </header>
      <LandingMap />
      <div className="map-legend-chips">
        <span><i style={{ background: "#c62828" }} /> Awaiting rescue</span>
        <span><i style={{ background: "#f59e0b" }} /> Team en route</span>
        <span><i style={{ background: "#4caf50" }} /> Resolved</span>
        <span><i style={{ background: "#2563eb" }} /> Rescue team</span>
        <span><i className="line" style={{ background: "#7c3aed" }} /> Road</span>
        <span><i className="line" style={{ background: "#facc15" }} /> Boat</span>
        <span><i className="line dashed" /> Air</span>
        <span><i className="depth" /> Water depth</span>
      </div>
    </article>
  );
}

export default function Home() {
  return (
    <main className="landing">
      <nav className="landing-nav" aria-label="Main navigation">
        <Link href="/" className="brand">Lifeline</Link>
      </nav>
      <section className="hero">
        <div>
          <h1>When the lines <em className="water">flood</em>, no caller should be <em>on hold</em>.</h1>
          <p className="hero-copy">Lifeline’s AI voice agent collects location, people and hazards, and puts a report on the dispatcher’s live map. Dispatchers send the teams. The AI takes the notes.</p>
          <div className="hero-actions"><Link className="button button-light" href="/console">Open dispatcher console <span>↗</span></Link></div>
        </div>
        <MapPreview />
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
