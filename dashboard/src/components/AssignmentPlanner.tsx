"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { fingerprintOf, pairBasis, WATER_TOLERANCE_M } from "../../convex/planning";
import {
  planAssignments,
  stateFingerprint,
  stateFloodFingerprint,
  stateInputs,
  type Plan,
  type Proposal,
  type RouteResult,
  type TeamOption,
  type Unassigned,
} from "@/lib/planner";
import type { Priority } from "@/lib/priority";
import type { RoutePlan } from "@/lib/router";
import { routeSteps } from "@/lib/routeText";
import { approvePlan, errorMessage, recordProposal } from "@/lib/store";
import type { ExerciseState, Incident, RescueTeam } from "@/lib/types";
import { capitalize } from "@/lib/text";
import { TierPill } from "./TierPill";

// Review panel for assignment suggestions. Each proposal is frozen when computed and bound to
// what it depends on: its incident (and linked reports), its team, its priority and the river
// level within WATER_TOLERANCE_M. While the panel is open it suggests again by itself (REFRESH_MS
// after a proposal goes out of date, an incident starts waiting or a team frees up), keeping
// the dispatcher's unchecked incidents unchecked.

const REFRESH_MS = 2000;

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
  /** River level planned with. */
  water: number;
  /** pairBasis of each proposal, by incident id. */
  basis: Map<string, string>;
  /** The waiting incidents and free teams planned for. */
  scope: string;
  routeContext: string;
  /** Whether the server's data matched the dashboard's when recorded; null while recording. */
  matched: boolean | null;
  /** Why this plan couldn't be recorded, if it couldn't. */
  recordError: string | null;
}

const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
const minutes = (s: number) => `${Math.max(1, Math.round(s / 60))} min`;

/** Which incidents are waiting for a team and which teams are free: a change may allow a better plan. */
function scopeOf(state: ExerciseState) {
  const waiting = state.incidents
    .filter((i) => !i.linkedTo && i.status === "awaiting_assignment" && i.locationVerified && i.latitude != null)
    .map((i) => i.id);
  const free = state.teams.filter((t) => t.available && t.currentAssignment == null && !t.trip).map((t) => t.id);
  return fingerprintOf([waiting.sort(), free.sort()]);
}

export function AssignmentPlanner({
  state,
  priorities,
  routeFor,
  routeContext = "",
  notReady,
  onPreview,
  onSelectIncident,
  onDone,
  onApproved,
  onClose,
}: {
  state: ExerciseState;
  priorities: Map<string, Priority>;
  routeFor: (team: RescueTeam, incident: Incident) => RouteResult;
  /** Identifies the local road and elevation data routeFor uses; a change makes a plan stale. */
  routeContext?: string;
  /** Why suggestions can't be made or approved right now (e.g. a local edit pending), or null. */
  notReady: string | null;
  onPreview: (route: RoutePlan | null) => void;
  onSelectIncident: (id: string) => void;
  onDone: (message: string) => void;
  /** Called with the approved proposals, so the console can send those teams straight away. */
  onApproved?: (approved: Proposal[]) => void;
  onClose: () => void;
}) {
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  /** Incidents the dispatcher unchecked; they stay unchecked when the plan refreshes. */
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const inputs = useMemo(() => stateInputs(state), [state]);
  const currentFlood = useMemo(() => stateFloodFingerprint(state), [state]);
  const currentScope = useMemo(() => scopeOf(state), [state]);
  /** Incidents whose proposal no longer matches what it was planned from. */
  const outdated = useMemo(() => {
    const out = new Set<string>();
    if (!suggestion) return out;
    const all =
      Math.abs(state.waterSurfaceElevation - suggestion.water) > WATER_TOLERANCE_M || suggestion.routeContext !== routeContext;
    for (const p of suggestion.plan.proposals) {
      if (
        all ||
        suggestion.basis.get(p.incident.id) !== pairBasis(inputs, p.incident.id, p.team.id) ||
        priorities.get(p.incident.id)?.tier !== p.tier
      ) {
        out.add(p.incident.id);
      }
    }
    return out;
  }, [suggestion, inputs, priorities, routeContext, state.waterSurfaceElevation]);
  /** Applies an update only if this plan is still the one on screen. */
  const forPlan = (planId: string, update: (s: Suggestion) => Suggestion) =>
    setSuggestion((s) => (s?.planId === planId ? update(s) : s));

  const suggest = (exclusions = excluded, { auto = false } = {}) => {
    const plan = planAssignments({ incidents: state.incidents, teams: state.teams, priorities, route: routeFor, excluded: exclusions });
    const next: Suggestion = {
      plan,
      planId: newId(),
      water: state.waterSurfaceElevation,
      basis: new Map(plan.proposals.map((p) => [p.incident.id, pairBasis(inputs, p.incident.id, p.team.id)])),
      scope: currentScope,
      routeContext,
      matched: null,
      recordError: null,
    };
    setSuggestion(next);
    setApprovalId(null);
    setRefusal(null);
    if (!auto) onPreview(null);
    if (plan.status !== "ok") return;
    recordProposal({
      planId: next.planId,
      fingerprint: stateFingerprint(state),
      floodFingerprint: currentFlood,
      water: next.water,
      proposals: plan.proposals.map((p) => ({
        incidentId: p.incident.id as never, teamId: p.team.id as never, tier: p.tier, seconds: p.seconds, reason: p.reason, evidence: p.evidence,
        basis: next.basis.get(p.incident.id)!,
      })),
      unassigned: plan.unassigned.map((u) => ({ incidentId: u.incident.id as never, reason: u.reason })),
    })
      .then((r) => forPlan(next.planId, (s) => ({ ...s, matched: r.matched })))
      .catch((e) => forPlan(next.planId, (s) => ({ ...s, recordError: errorMessage(e) })));
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
      const chosen = suggestion.plan.proposals.filter((p) => !unchecked.has(p.incident.id));
      const result = await approvePlan({
        planId: suggestion.planId,
        approvalId: id,
        selected: chosen.map((p) => ({ incidentId: p.incident.id as never, teamId: p.team.id as never, evidence: p.evidence })),
      });
      if (result.ok) {
        onPreview(null);
        onApproved?.(chosen);
        onDone(`Approved: ${result.assigned} team${result.assigned === 1 ? "" : "s"} assigned and sent. Callers hear the update.`);
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

  // Suggest as soon as the panel opens (or becomes ready), and again whenever a proposal goes
  // out of date or the waiting incidents or free teams change.
  const refresh =
    suggestion == null ||
    outdated.size > 0 ||
    suggestion.scope !== currentScope ||
    suggestion.matched === false;
  const autoSuggest = refresh && notReady == null && !busy;
  // The timer must plan from the data on screen when it fires, not when it was set.
  const latestSuggest = useRef(suggest);
  useEffect(() => {
    latestSuggest.current = suggest;
  });
  const planId = suggestion?.planId ?? null;
  useEffect(() => {
    if (!autoSuggest) return;
    // Right away when the panel opens; otherwise after a pause, so a burst of changes is one refresh.
    const t = setTimeout(() => latestSuggest.current(undefined, { auto: planId != null }), planId == null ? 0 : REFRESH_MS);
    return () => clearTimeout(t);
    // When a refresh becomes due, and again after each plan if one is still due.
  }, [autoSuggest, planId]);

  const plan = suggestion?.plan;
  const chosen = plan?.proposals.filter((p) => !unchecked.has(p.incident.id)) ?? [];
  const stale = chosen.some((p) => outdated.has(p.incident.id));
  const canApprove = !!plan && chosen.length > 0 && !stale && notReady == null && suggestion?.matched === true && !busy;

  return (
    <div className="planner">
      <header className="planner-header">
        <h2>Suggested assignments</h2>
        <button onClick={onClose} className="close-button" aria-label="Close suggestions">
          ✕
        </button>
      </header>

      {!plan && (
        <div className="planner-intro">
          {notReady == null && <p>Finding a team for each waiting incident…</p>}
          <button disabled={notReady != null} onClick={() => suggest()} className="primary-button w-full">
            Suggest assignments
          </button>
          {notReady && <p className="planner-notice planner-notice-amber">{notReady}</p>}
        </div>
      )}

      {plan && (
        <>
          {plan.status === "ok" && (
            <dl className="planner-stats">
              {(["critical", "high", "standard"] as const)
                .filter((t) => plan.coverage[t].waiting)
                .map((t) => (
                  <div key={t}>
                    <dt>{capitalize(t)}</dt>
                    <dd>
                      {plan.coverage[t].covered}
                      <span>/{plan.coverage[t].waiting} covered</span>
                    </dd>
                  </div>
                ))}
              <div>
                <dt>Total travel</dt>
                <dd>{minutes(plan.totalSeconds)}</dd>
              </div>
            </dl>
          )}
          {plan.message && <p className="planner-notice planner-notice-amber">{plan.message}</p>}
          {(stale || suggestion?.matched === false) && (
            <p role="alert" className="planner-notice planner-notice-amber">
              {notReady == null
                ? "Things changed since these suggestions were made (a team, an incident, the river or a priority). Updating…"
                : "Things changed since these suggestions were made. Suggest again before approving."}
            </p>
          )}
          {notReady && <p className="planner-notice planner-notice-amber">{notReady}</p>}
          {(refusal ?? suggestion?.recordError) && (
            <p role="alert" className="planner-notice planner-notice-red">
              {refusal ?? suggestion?.recordError}
            </p>
          )}

          <ul className="planner-list">
            {plan.proposals.map((p) => (
              <ProposalCard
                key={p.incident.id}
                proposal={p}
                checked={!unchecked.has(p.incident.id)}
                outdated={outdated.has(p.incident.id)}
                expanded={open === p.incident.id}
                onToggle={() => {
                  // A different selection is a different request: it gets its own approval ID.
                  setApprovalId(null);
                  setUnchecked((s) => {
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
              <h3 className="planner-label">Not assigned</h3>
              <ul className="planner-list">
                {plan.unassigned.map((u) => (
                  <UnassignedRow key={u.incident.id} item={u} onSelect={() => onSelectIncident(u.incident.id)} />
                ))}
              </ul>
            </section>
          )}


          <div className="planner-footer">
            <div className="flex gap-2">
              <button disabled={!canApprove} onClick={approve} className="primary-button flex-1">
                {busy ? "Sending…" : `Approve ${chosen.length} selected`}
              </button>
              <button disabled={notReady != null || busy} onClick={() => suggest()} className="soft-button">
                Suggest again
              </button>
            </div>
            {excluded.size > 0 && (
              <button onClick={() => { setExcluded(new Set()); suggest(new Set()); }} className="planner-link">
                Clear {excluded.size} exclusion{excluded.size === 1 ? "" : "s"}
              </button>
            )}
          </div>
        </>
      )}

    </div>
  );
}

function ProposalCard({
  proposal: p,
  checked,
  outdated,
  expanded,
  onToggle,
  onExpand,
  onPreview,
  onSelect,
  onExclude,
}: {
  proposal: Proposal;
  checked: boolean;
  outdated: boolean;
  expanded: boolean;
  onToggle: () => void;
  onExpand: () => void;
  onPreview: () => void;
  onSelect: () => void;
  onExclude: () => void;
}) {
  return (
    <li className={`plan-card ${checked ? "" : "is-unchecked"} ${outdated ? "is-outdated" : ""}`}>
      <div className="plan-card-top">
        <input type="checkbox" checked={checked} onChange={onToggle} aria-label={`Include ${p.incident.reportedAddress}`} />
        <button onClick={onSelect} className="plan-card-title" title="Open incident">
          {capitalize(p.incident.reportedAddress)}
        </button>
        <TierPill priority={{ tier: p.tier }} />
      </div>
      <div className="plan-team">
        <span className="plan-team-name">→ {p.team.name}</span>
        <span className="plan-team-eta">~{minutes(p.seconds)}</span>
      </div>
      <RouteSteps route={p.route} />
      {addsInformation(p.reason) && <p className="plan-reason">{capitalize(p.reason)}</p>}
      <div className="plan-actions">
        <button onClick={onPreview}>Show route</button>
        <button onClick={onExpand}>
          {expanded ? "Hide" : "Alternatives"} ({p.alternatives.length - 1})
        </button>
        <button onClick={onExclude}>Exclude this team</button>
      </div>
      {expanded && <Options options={p.alternatives} />}
    </li>
  );
}

function UnassignedRow({ item, onSelect }: { item: Unassigned; onSelect: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="plan-card is-unassigned">
      <div className="plan-card-top">
        <button onClick={onSelect} className="plan-card-title" title="Open incident">
          {capitalize(item.incident.reportedAddress)}
        </button>
        {item.tier && <TierPill priority={{ tier: item.tier }} />}
      </div>
      <p className="plan-reason">{capitalize(item.reason)}</p>
      {item.alternatives.length > 0 && (
        <>
          <div className="plan-actions">
            <button onClick={() => setOpen((o) => !o)}>{open ? "Hide teams" : `Teams (${item.alternatives.length})`}</button>
          </div>
          {open && <Options options={item.alternatives} />}
        </>
      )}
    </li>
  );
}

/** Reasons that only restate the travel time already shown on the card. */
const addsInformation = (reason: string) => !/^(Fastest eligible team|Best option in the overall plan) \(/.test(reason);

function RouteSteps({ route }: { route: RoutePlan }) {
  const { steps, deepest } = routeSteps(route);
  return (
    <div className="plan-route">
      <ol>
        {steps.map((step, n) => (
          <li key={step.mode}>
            {n > 0 && <span aria-hidden className="plan-route-arrow">→</span>}
            <span className="plan-route-step">
              <span>{step.label}</span> {step.distance}
            </span>
          </li>
        ))}
      </ol>
      {deepest && <p>{deepest}</p>}
    </div>
  );
}

const OPTION_CHIP: Record<TeamOption["state"], string> = {
  proposed: "chip-green",
  eligible: "chip-blue",
  used_elsewhere: "chip-neutral",
  excluded: "chip-neutral",
  no_route: "chip-red",
  cannot_evaluate: "chip-amber",
};

function Options({ options }: { options: TeamOption[] }) {
  return (
    <ul className="plan-options">
      {options.map((o) => (
        <li key={o.team.id}>
          <div className="flex items-center gap-2">
            <span className="font-medium text-slate-100">{o.team.name}</span>
            <span className={`chip ${OPTION_CHIP[o.state]}`}>{OPTION_LABEL[o.state]}</span>
            {o.seconds != null && <span className="ml-auto font-mono text-[11px] text-slate-400">~{minutes(o.seconds)}</span>}
          </div>
          {o.state !== "proposed" && <p>{capitalize(o.note)}</p>}
        </li>
      ))}
    </ul>
  );
}
