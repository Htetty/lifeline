import type { Priority } from "@/lib/priority";
import type { PriorityTier } from "@/lib/types";

export const TIER_STYLE: Record<PriorityTier, { label: string; cls: string }> = {
  critical: { label: "CRITICAL", cls: "bg-red-600 text-white" },
  high: { label: "HIGH", cls: "bg-orange-500 text-slate-950" },
  standard: { label: "STANDARD", cls: "bg-slate-600 text-slate-100" },
};

export function TierPill({ priority }: { priority?: Pick<Priority, "tier" | "overrideReason"> }) {
  if (!priority) return null;
  const t = TIER_STYLE[priority.tier];
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold tracking-wide ${t.cls}`}>
      {t.label}
      {priority.overrideReason != null && " ✎"}
    </span>
  );
}

