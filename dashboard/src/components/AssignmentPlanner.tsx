"use client";

import { useMemo, useState } from "react";
import {
  describePlan,
  planAssignments,
  priorityFingerprint,
  stateFingerprint,
  stateFloodFingerprint,
  type Plan,
  type Proposal,
  type RouteResult,
  type TeamOption,
  type Unassigned,
} from "@/lib/planner";
import type { Priority } from "@/lib/priority";
import type { RoutePlan } from "@/lib/router";
import { routeSummary } from "@/lib/routeText";
import { callerLocationLabel } from "@/lib/callerLocation";
import { approvePlan, errorMessage, explainPlan, recordProposal } from "@/lib/store";
import type { ExerciseState, Incident, RescueTeam } from "@/lib/types";
import { TierPill } from "./TierPill";

// Review panel for assignment suggestions. The plan is frozen when computed; if anything it
// depends on changes (server data, caller water reports, the computed priorities, the local
// route model) or a local edit is pending, approval waits for a fresh suggestion.

const OPTION_LABEL: Record<TeamOption["state"], string> = {
  proposed: "Proposed",
  eligible: "Could go",
  used_elsewhere: "Proposed elsewhere",
  excluded: "Excluded",
  no_route: "No route",
  cannot_evaluate: "Cannot evaluate",
};

interface Suggestion {
  plan: Plan;
  planId: string;
  fingerprint: string;
  flood: string;
  priorities: string;
  routeContext: string;
  /** Whether the server's data matched the dashboard's when recorded; null while recording. */
  matched: boolean | null;
  /** Claude's summary of this plan, once it arrives (never one for an earlier plan). */
  summary: { text: string | null; note: string } | null;
  /** Why this plan couldn't be recorded, if it couldn't. */
  recordError: string | null;
}

const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
const minutes = (s: number) => `${Math.max(1, Math.round(s / 60))} min`;

export function AssignmentPlanner({
  state,
  priorities,
  routeFor,
  routeContext = "",
  notReady,
  onPreview,
  onSelectIncident,
  onDone,
  onClose,
}: {
  state: ExerciseState;
  priorities: Map<string, Priority>;
  routeFor: (team: RescueTeam, incident: Incident) => RouteResult;
  /** Identifies the local road and flood model routeFor uses; a change makes a plan stale. */
  routeContext?: string;
  /** Why suggestions can't be made or approved right now (e.g. a local edit pending), or null. */
  notReady: string | null;
  onPreview: (route: RoutePlan | null) => void;
  onSelectIncident: (id: string) => void;
  onDone: (message: string) => void;
  onClose: () => void;
}) {
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const current = useMemo(() => stateFingerprint(state), [state]);
  const currentFlood = useMemo(() => stateFloodFingerprint(state), [state]);
  const currentPriorities = useMemo(() => priorityFingerprint(priorities), [priorities]);
  const stale =
    suggestion != null &&
    (suggestion.fingerprint !== current ||
      suggestion.flood !== currentFlood ||
      suggestion.priorities !== currentPriorities ||
      suggestion.routeContext !== routeContext);
  /** Applies an update only if this plan is still the one on screen. */
  const forPlan = (planId: string, update: (s: Suggestion) => Suggestion) =>
    setSuggestion((s) => (s?.planId === planId ? update(s) : s));

  const suggest = (exclusions = excluded) => {
    const plan = planAssignments({ incidents: state.incidents, teams: state.teams, priorities, route: routeFor, excluded: exclusions });
    const next: Suggestion = {
      plan,
      planId: newId(),
      fingerprint: current,
      flood: currentFlood,
      priorities: currentPriorities,
      routeContext,
      matched: null,
      summary: null,
      recordError: null,
    };
    setSuggestion(next);
    setSelected(new Set(plan.proposals.map((p) => p.incident.id)));
    setApprovalId(null);
    setRefusal(null);
    onPreview(null);
    if (plan.status !== "ok") return;
    recordProposal({
      planId: next.planId,
      fingerprint: next.fingerprint,
      floodFingerprint: next.flood,
      proposals: plan.proposals.map((p) => ({
        incidentId: p.incident.id as never, teamId: p.team.id as never, tier: p.tier, seconds: p.seconds, reason: p.reason, evidence: p.evidence,
      })),
      unassigned: plan.unassigned.map((u) => ({ incidentId: u.incident.id as never, reason: u.reason })),
    })
      .then((r) => forPlan(next.planId, (s) => ({ ...s, matched: r.matched })))
      .catch((e) => forPlan(next.planId, (s) => ({ ...s, recordError: errorMessage(e) })));
    // Optional and non-blocking: the deterministic summary is shown until (unless) this returns.
    explainPlan(describePlan(plan))
      .then((r) => forPlan(next.planId, (s) => ({ ...s, summary: r })))
      .catch(() => forPlan(next.planId, (s) => ({ ...s, summary: { text: null, note: "Claude summary unavailable" } })));
  };

  const exclude = (p: Proposal) => {
    const next = new Set(excluded).add(`${p.incident.id}|${p.team.id}`);
    setExcluded(next);
    suggest(next);
  };

  const approve = async () => {
    if (!suggestion) return;
    const id = approvalId ?? newId(); // reused only to retry this same selection after a network error
    setApprovalId(id);
    setBusy(true);
    try {
      const chosen = suggestion.plan.proposals.filter((p) => selected.has(p.incident.id));
      const result = await approvePlan({
        planId: suggestion.planId,
        approvalId: id,
        selected: chosen.map((p) => ({ incidentId: p.incident.id as never, teamId: p.team.id as never, evidence: p.evidence })),
      });
      if (result.ok) {
        onPreview(null);
        onDone(`Approved: ${result.assigned} team${result.assigned === 1 ? "" : "s"} assigned. Callers hear the approved update.`);
        onClose();
      } else {
        setRefusal(`Not applied: ${result.reason}`);
      }
    } catch (e) {
      setRefusal(`${errorMessage(e)} You can retry; it won't assign anything twice.`);
    } finally {
      setBusy(false);
    }
  };

  const plan = suggestion?.plan;
  const chosen = plan?.proposals.filter((p) => selected.has(p.incident.id)) ?? [];
  const summary = suggestion?.summary ?? null;
  const canApprove = !!plan && chosen.length > 0 && !stale && notReady == null && suggestion?.matched === true && !busy;

  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">Suggested assignments</h2>
          <p className="text-xs text-slate-400">Simulation. Nothing changes until you approve.</p>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-white" aria-label="Close suggestions">
          ✕
        </button>
      </div>

      {!plan && (
        <div className="space-y-2">
          <p className="text-xs text-slate-300">
            Proposes one available team per waiting incident for the whole queue: as many critical incidents covered as possible,
            then high, then standard; then the least simulated travel time for critical incidents, then high, then standard. Only
            routes the flood-aware router finds count.
          </p>
          <button
            disabled={notReady != null}
            onClick={() => suggest()}
            className="w-full rounded bg-sky-500 px-2.5 py-1.5 text-xs font-semibold text-slate-950 disabled:opacity-40"
          >
            Suggest assignments
          </button>
          {notReady && <p className="text-xs text-amber-300">{notReady}</p>}
        </div>
      )}

      {plan && (
        <>
          {plan.status === "ok" && (
            <p className="text-xs text-slate-300">
              Covers {(["critical", "high", "standard"] as const)
                .filter((t) => plan.coverage[t].waiting)
                .map((t) => `${plan.coverage[t].covered}/${plan.coverage[t].waiting} ${t}`)
                .join(" · ")}{" "}
              · total {minutes(plan.totalSeconds)} simulated travel
            </p>
          )}
          {plan.message && <p className="rounded bg-slate-800 p-2 text-xs text-amber-200">{plan.message}</p>}
          {stale && (
            <p role="alert" className="rounded bg-amber-400/15 p-2 text-xs text-amber-200 ring-1 ring-amber-400/50">
              Something this plan depends on has changed (a team, an incident, a caller&apos;s water report, the river, or a computed
              priority). Suggest again before approving.
            </p>
          )}
          {suggestion?.matched === false && !stale && (
            <p role="alert" className="rounded bg-amber-400/15 p-2 text-xs text-amber-200">
              This screen was behind the latest data. Suggest again.
            </p>
          )}
          {notReady && <p className="rounded bg-slate-800 p-2 text-xs text-amber-200">{notReady}</p>}
          {(refusal ?? suggestion?.recordError) && (
            <p role="alert" className="rounded bg-red-500/15 p-2 text-xs text-red-200 ring-1 ring-red-400/50">
              {refusal ?? suggestion?.recordError}
            </p>
          )}

          <ul className="space-y-2">
            {plan.proposals.map((p) => (
              <ProposalCard
                key={p.incident.id}
                proposal={p}
                checked={selected.has(p.incident.id)}
                expanded={open === p.incident.id}
                onToggle={() => {
                  // A different selection is a different request: it gets its own approval ID.
                  setApprovalId(null);
                  setSelected((s) => {
                    const n = new Set(s);
                    if (n.has(p.incident.id)) n.delete(p.incident.id);
                    else n.add(p.incident.id);
                    return n;
                  });
                }}
                onExpand={() => setOpen((o) => (o === p.incident.id ? null : p.incident.id))}
                onPreview={() => onPreview(p.route)}
                onSelect={() => onSelectIncident(p.incident.id)}
                onExclude={() => exclude(p)}
              />
            ))}
          </ul>

          {plan.unassigned.length > 0 && (
            <section>
              <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">Not assigned</h3>
              <ul className="space-y-1.5">
                {plan.unassigned.map((u) => (
                  <UnassignedRow key={u.incident.id} item={u} onSelect={() => onSelectIncident(u.incident.id)} />
                ))}
              </ul>
            </section>
          )}

          {plan.status === "ok" && (
            <details className="rounded bg-slate-800/70 p-2 text-xs">
              <summary className="cursor-pointer text-slate-400">Why this plan</summary>
              {summary?.text && (
                <p className="mt-1.5 text-slate-200">
                  {summary.text} <span className="text-slate-500">({summary.note})</span>
                </p>
              )}
              <pre className="mt-1.5 whitespace-pre-wrap font-sans text-slate-300">{describePlan(plan)}</pre>
              {summary && !summary.text && <p className="mt-1 text-slate-500">{summary.note}</p>}
            </details>
          )}

          <div className="flex gap-2">
            <button
              disabled={!canApprove}
              onClick={approve}
              className="flex-1 rounded bg-red-600 px-2.5 py-1.5 text-xs font-semibold disabled:opacity-40"
            >
              {busy ? "Approving…" : `Approve ${chosen.length} selected`}
            </button>
            <button
              disabled={notReady != null || busy}
              onClick={() => suggest()}
              className="rounded bg-slate-700 px-2.5 py-1.5 text-xs hover:bg-slate-600 disabled:opacity-40"
            >
              Suggest again
            </button>
          </div>
          {excluded.size > 0 && (
            <button onClick={() => { setExcluded(new Set()); suggest(new Set()); }} className="text-xs text-sky-300 underline">
              Clear {excluded.size} exclusion{excluded.size === 1 ? "" : "s"}
            </button>
          )}
        </>
      )}

      <p className="text-[10px] leading-snug text-slate-500">
        Travel times and water depths come from the simulation (OpenStreetMap roads, a simplified flood model); a route isn&apos;t
        verified as passable. Team capacity, staffing and medical capability aren&apos;t modeled. Approving assigns teams; sending
        them is still your call.
      </p>
    </div>
  );
}

function ProposalCard({
  proposal: p,
  checked,
  expanded,
  onToggle,
  onExpand,
  onPreview,
  onSelect,
  onExclude,
}: {
  proposal: Proposal;
  checked: boolean;
  expanded: boolean;
  onToggle: () => void;
  onExpand: () => void;
  onPreview: () => void;
  onSelect: () => void;
  onExclude: () => void;
}) {
  return (
    <li className="rounded bg-slate-800/70 p-2.5 text-xs">
      <div className="flex items-start gap-2">
        <input type="checkbox" checked={checked} onChange={onToggle} aria-label={`Include ${p.incident.reportedAddress}`} className="mt-0.5" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <TierPill priority={{ tier: p.tier }} />
            <button onClick={onSelect} className="truncate text-left font-medium hover:underline">{p.incident.reportedAddress}</button>
            {callerLocationLabel(p.incident)?.confirmed === false && <span className="text-amber-300">Caller unconfirmed</span>}
          </div>
          <p>
            → <b>{p.team.name}</b> · ~{minutes(p.seconds)} (simulated) · {routeSummary(p.route)}
          </p>
          <p className="text-slate-300">{p.reason}</p>
          {p.unknowns.length > 0 && <p className="text-amber-200/90">Check: {p.unknowns.join(" · ")}</p>}
          <div className="flex flex-wrap gap-2 pt-0.5">
            <button onClick={onPreview} className="text-sky-300 underline">Show route</button>
            <button onClick={onExpand} className="text-sky-300 underline">
              {expanded ? "Hide" : "Alternatives"} ({p.alternatives.length - 1})
            </button>
            <button onClick={onExclude} className="text-slate-400 underline">Exclude this team</button>
          </div>
          {expanded && <Options options={p.alternatives} />}
        </div>
      </div>
    </li>
  );
}

function UnassignedRow({ item, onSelect }: { item: Unassigned; onSelect: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded bg-slate-900 p-2 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        {item.tier && <TierPill priority={{ tier: item.tier }} />}
        <button onClick={onSelect} className="font-medium hover:underline">{item.incident.reportedAddress}</button>
      </div>
      <p className="mt-0.5 text-slate-300">{item.reason}</p>
      {item.alternatives.length > 0 && (
        <>
          <button onClick={() => setOpen((o) => !o)} className="mt-0.5 text-sky-300 underline">
            {open ? "Hide teams" : `Teams (${item.alternatives.length})`}
          </button>
          {open && <Options options={item.alternatives} />}
        </>
      )}
    </li>
  );
}

function Options({ options }: { options: TeamOption[] }) {
  return (
    <ul className="mt-1 space-y-0.5 border-l border-slate-700 pl-2">
      {options.map((o) => (
        <li key={o.team.id}>
          <b>{o.team.name}</b>: {OPTION_LABEL[o.state]}
          {o.seconds != null && ` · ~${minutes(o.seconds)} (simulated)`}
          {o.state !== "proposed" && <span className="text-slate-400"> · {o.note}</span>}
        </li>
      ))}
    </ul>
  );
}
