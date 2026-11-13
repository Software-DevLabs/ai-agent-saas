import type { ActivityStatus } from "@/lib/domain";
import type { StatusTone } from "@/components/ui/status-dot";

/** Run and node statuses folded onto the six dot tones the console uses. */
export function activityTone(status: ActivityStatus): StatusTone {
  switch (status) {
    case "RUNNING":
      return "active";
    case "SUCCEEDED":
      return "success";
    case "FAILED":
      return "danger";
    case "BLOCKED":
      return "warning";
    case "PENDING":
      return "idle";
    default:
      return "neutral";
  }
}

export function isLiveStatus(status: ActivityStatus): boolean {
  return status === "RUNNING" || status === "PENDING";
}
