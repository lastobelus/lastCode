import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import { browserThreadLinkTarget } from "@t3tools/shared/threadLinks";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentThreadShells } from "~/state/threads";

export function useOpenBrowserThreadLink() {
  const navigate = useNavigate();
  return (href: string, environmentId: EnvironmentId) => {
    const target = browserThreadLinkTarget(
      href,
      environmentId,
      appAtomRegistry.get(environmentThreadShells.threadRefsAtom),
    );
    if (target) void navigate({ to: "/$environmentId/$threadId", params: target });
  };
}
