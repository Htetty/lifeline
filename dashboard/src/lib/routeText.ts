import type { RoutePlan } from "./router";

const LEG_WORDS = { road: "drive", water: "boat", foot: "on foot", air: "fly" } as const;

function distance(m: number) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

/** e.g. "tow 2.3 km → boat 380 m → on foot 80 m · deepest water 0.3 of 0.6 m" */
export function routeSummary(plan: RoutePlan) {
  const steps = [...new Set(plan.legs.map((l) => l.mode))].map((mode) => {
    const word = mode === "road" && plan.mover === "boat" ? "tow" : LEG_WORDS[mode];
    return `${word} ${distance(plan.metres[mode])}`;
  });
  const depth = plan.limit != null && plan.maxDepth > 0.05 ? ` · deepest water ${plan.maxDepth.toFixed(1)} of ${plan.limit} m` : "";
  return steps.join(" → ") + depth;
}


const STEP_LABEL = { road: "Drive", water: "By boat", foot: "On foot", air: "Fly" } as const;

/** The route as labelled steps, e.g. [Towed by road 6.2 km, On foot 42 m], plus the deepest water on it. */
export function routeSteps(plan: RoutePlan) {
  const steps = [...new Set(plan.legs.map((l) => l.mode))].map((mode) => ({
    mode,
    label: mode === "road" && plan.mover === "boat" ? "Towed by road" : STEP_LABEL[mode],
    distance: distance(plan.metres[mode]),
  }));
  const deepest =
    plan.limit != null && plan.maxDepth > 0.05 ? `Deepest water ${plan.maxDepth.toFixed(1)} m (limit ${plan.limit} m)` : null;
  return { steps, deepest };
}
