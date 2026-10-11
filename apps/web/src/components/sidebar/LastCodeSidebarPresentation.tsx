import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentIconColor } from "@t3tools/contracts/settings";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { useOpenPrLink } from "../../lib/openPullRequestLink";
import type { SidebarProviderBadgePreferences } from "./SidebarEnvironmentIcon";

interface Presentation {
  providerEntriesByEnvironmentId: ReadonlyMap<string, ReadonlyMap<string, ProviderInstanceEntry>>;
  environmentIconColors: Readonly<Record<string, EnvironmentIconColor>>;
  providerBadgePreferences: SidebarProviderBadgePreferences;
  openPullRequestsInRightPanel: boolean;
  projectEnvironments: {
    desktopLocalEnvironmentIds: ReadonlySet<EnvironmentId>;
    knownEnvironmentIds: ReadonlySet<EnvironmentId>;
    showLocalEnvironmentIcon: boolean;
  };
  openPrLink: ReturnType<typeof useOpenPrLink>;
}
const PresentationContext = createContext<Presentation | null>(null);
/** Low-frequency catalog/presentation inputs and the shared PR opener, under the lazy sidebar. */
export function LastCodeSidebarPresentationProvider({
  children,
  providerEntriesByEnvironmentId,
  environmentIconColors,
  providerBadgePreferences,
  openPullRequestsInRightPanel,
  projectEnvironments,
}: Omit<Presentation, "openPrLink"> & { children: ReactNode }) {
  const openPrLink = useOpenPrLink();
  const value = useMemo(
    () => ({
      providerEntriesByEnvironmentId,
      environmentIconColors,
      providerBadgePreferences,
      openPullRequestsInRightPanel,
      openPrLink,
      projectEnvironments,
    }),
    [
      providerEntriesByEnvironmentId,
      environmentIconColors,
      providerBadgePreferences,
      openPullRequestsInRightPanel,
      openPrLink,
      projectEnvironments,
    ],
  );
  return <PresentationContext.Provider value={value}>{children}</PresentationContext.Provider>;
}
export function useLastCodeSidebarPresentation() {
  const presentation = useContext(PresentationContext);
  if (!presentation) throw new Error("LastCode row presentation requires its sidebar provider.");
  return presentation;
}
