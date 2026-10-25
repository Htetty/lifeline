import type { Priority } from "@/lib/priority";
import type { PriorityTier } from "@/lib/types";

export const TIER_STYLE: Record<PriorityTier, { label: string; cls: string }> = {
  critical: { label: "CRITICAL", cls: "chip-red" },
  high: { label: "HIGH", cls: "chip-orange" },
  standard: { label: "STANDARD", cls: "chip-neutral" },
};

export function TierPill({ priority }: { priority?: Pick<Priority, "tier" | "overrideReason"> }) {
  if (!priority) return null;
  const t = TIER_STYLE[priority.tier];
  return (
    <span className={`chip ${t.cls}`}>
      {t.label}
      {priority.overrideReason != null && " ✎"}
    </span>
  );
}

