import { useRouter } from "@tanstack/react-router";
import type { AppRouter } from "~/router";
import { safeThreadRouteParams } from "~/threadRoutes";
import type { EnvironmentId } from "@t3tools/contracts";
import { browserThreadLinkTarget } from "@t3tools/shared/threadLinks";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentThreadShells } from "~/state/threads";

export function openBrowserThreadLink(
  router: AppRouter,
  href: string,
  environmentId: EnvironmentId,
) {
  const target = browserThreadLinkTarget(
    href,
    environmentId,
    appAtomRegistry.get(environmentThreadShells.threadRefsAtom),
  );
  const params = target && safeThreadRouteParams(router, target);
  if (params) void router.navigate({ to: "/$environmentId/$threadId", params });
}

export function useOpenBrowserThreadLink() {
  const router = useRouter();
  return (href: string, environmentId: EnvironmentId) =>
    openBrowserThreadLink(router, href, environmentId);
}
