import type { PreviewHostingActivityInput } from "@t3tools/contracts";
import { isLocalLoopbackHost, isPrivateNetworkHost } from "@t3tools/shared/hostClassification";
import * as Effect from "effect/Effect";

import type { PreviewHosting } from "./Hosting.ts";

/** Each connection owns its declarations, including cleanup after an interrupted preparation. */
export const makeHostingClientActivity = Effect.fn("HostingClientActivity.make")(function* (
  hosting: PreviewHosting["Service"],
  owner: string,
) {
  const active = new Map<string, PreviewHostingActivityInput>();
  yield* Effect.addFinalizer(() =>
    Effect.forEach(active.values(), (input) => hosting.setActivity({ ...input, active: false }), {
      discard: true,
    }),
  );
  return Effect.fn("HostingClientActivity.set")(function* (input: PreviewHostingActivityInput) {
    const activityId = `client:${owner}:${input.activityId}`;
    let url = input.url;
    if (input.active) {
      const target = URL.canParse(url) ? new URL(url) : null;
      if (
        target &&
        isPrivateNetworkHost(target.hostname) &&
        !isLocalLoopbackHost(target.hostname)
      ) {
        const port = target.port || (target.protocol === "https:" ? "443" : "80");
        const origins = new Set(
          (yield* hosting.list(input.threadId)).flatMap((lease) => {
            const local = new URL(lease.url);
            return (local.port || (local.protocol === "https:" ? "443" : "80")) === port
              ? [local.origin]
              : [];
          }),
        );
        if (origins.size === 1) {
          const local = new URL([...origins][0]!);
          target.protocol = local.protocol;
          target.host = local.host;
          url = target.href;
        }
      }
    }
    const declaration = { ...input, activityId, url };
    if (input.active) active.set(activityId, declaration);
    yield* hosting.setActivity(declaration);
    if (!input.active) active.delete(activityId);
  });
});
