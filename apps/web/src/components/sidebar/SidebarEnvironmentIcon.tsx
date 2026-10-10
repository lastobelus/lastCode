import { resolveEnvironmentMachineKind, type EnvironmentId } from "@t3tools/contracts";
import { useMemo, type ComponentProps } from "react";

import { EnvironmentIcon, resolveEnvironmentIconColor } from "../../environmentIcons";
import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { useEnvironment } from "../../state/environments";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";

export interface SidebarProviderBadgePreferences {
  readonly enabled: boolean;
  readonly size: number;
  readonly transparency: number;
}

export function useSidebarProviderBadgePreferences(): SidebarProviderBadgePreferences {
  const settings = useClientSettings();
  return useMemo(
    () => ({
      enabled: settings.showThreadProviderBadge,
      size: settings.threadProviderBadgeSize,
      transparency: settings.threadProviderBadgeTransparency,
    }),
    [
      settings.showThreadProviderBadge,
      settings.threadProviderBadgeSize,
      settings.threadProviderBadgeTransparency,
    ],
  );
}

type SidebarEnvironmentIconProps = ComponentProps<typeof EnvironmentIcon> & {
  readonly provider?: Pick<
    ProviderInstanceEntry,
    "driverKind" | "displayName" | "acpRegistryAgentId" | "acpRegistryIconUrl"
  > | null;
  readonly badgeSize: number;
  readonly badgeTransparency: number;
};

/** The provider sits on the machine glyph without changing the row's icon track. */
export function SidebarEnvironmentIcon({
  provider,
  badgeSize,
  badgeTransparency,
  className,
  ...props
}: SidebarEnvironmentIconProps) {
  return (
    <span
      aria-hidden={props["aria-hidden"]}
      className={cn("relative inline-flex shrink-0 items-center justify-center", className)}
    >
      <EnvironmentIcon {...props} className="size-full" />
      {provider ? (
        <span
          aria-hidden
          className="pointer-events-none absolute -right-1/4 -bottom-1/4 z-40 flex items-center justify-center rounded-sm bg-sidebar-row-hover text-foreground"
          style={{
            width: `${badgeSize}%`,
            height: `${badgeSize}%`,
            opacity: 1 - badgeTransparency / 100,
            containerType: "inline-size",
          }}
        >
          <ProviderInstanceIcon
            driverKind={provider.driverKind}
            displayName={provider.displayName}
            acpRegistryAgentId={provider.acpRegistryAgentId}
            acpRegistryIconUrl={provider.acpRegistryIconUrl}
            className="size-full"
            iconClassName="size-5/6"
            fallbackFontSize="65cqi"
          />
        </span>
      ) : null}
    </span>
  );
}

export function ConnectedSidebarEnvironmentIcon({
  environmentId,
  ...props
}: Omit<SidebarEnvironmentIconProps, "kind"> & { readonly environmentId: EnvironmentId }) {
  const environment = useEnvironment(environmentId);
  const savedColor = useClientSettings((settings) => settings.environmentIconColors[environmentId]);
  return (
    <SidebarEnvironmentIcon
      {...props}
      color={props.color ?? resolveEnvironmentIconColor(savedColor, environment !== null)}
      kind={resolveEnvironmentMachineKind(environment?.serverConfig ?? null)}
    />
  );
}
