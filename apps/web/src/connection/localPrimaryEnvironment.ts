import type { ConnectionTarget } from "@t3tools/client-runtime/connection";

import { isLoopbackHostname } from "../environments/primary/target";

/** Use the registered target, so a transient desktop bootstrap failure cannot break rendering. */
export function isClientLocalPrimaryTarget(
  target: ConnectionTarget | undefined,
  desktop: boolean,
): boolean {
  if (target?._tag !== "PrimaryConnectionTarget") return false;
  if (desktop) return true;
  try {
    return isLoopbackHostname(new URL(target.httpBaseUrl).hostname);
  } catch {
    return false;
  }
}
