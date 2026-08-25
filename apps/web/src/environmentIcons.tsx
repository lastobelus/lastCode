import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentIconColor } from "@t3tools/contracts/settings";
import { ContainerIcon, MonitorIcon, ServerIcon } from "lucide-react";
import type { CSSProperties } from "react";

import { cn } from "./lib/utils";

export type EnvironmentIconKind = "container" | "monitor" | "server";
export type EnvironmentIconContext = "hover" | "legacy-row" | "project" | "settings" | "v2-row";

const DEFAULT_CONTEXT_CLASS: Record<EnvironmentIconContext, string> = {
  hover: "text-muted-foreground",
  "legacy-row": "text-muted-foreground/40",
  project: "text-icon-muted",
  settings: "text-muted-foreground",
  "v2-row": "text-sidebar-muted-foreground/70",
};

export function normalizeEnvironmentIconColor(value: string): EnvironmentIconColor | undefined {
  const normalized = value.trim().toLowerCase();
  return /^#[\da-f]{6}$/.test(normalized) ? (normalized as EnvironmentIconColor) : undefined;
}

export function updateEnvironmentIconColors(
  colors: Readonly<Record<string, EnvironmentIconColor>>,
  environmentId: EnvironmentId,
  value: string,
): Record<string, EnvironmentIconColor> {
  const next = { ...colors };
  const normalized = normalizeEnvironmentIconColor(value);
  if (normalized === undefined) {
    delete next[environmentId];
  } else {
    next[environmentId] = normalized;
  }
  return next;
}

export function formatLocalEnvironmentLabel(label: string | null | undefined): string {
  const normalized = label?.trim();
  return `${normalized && normalized.length > 0 ? normalized : "Local"} (local)`;
}

export function environmentIconKind(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
): "monitor" | "server" {
  return environmentId === primaryEnvironmentId ? "monitor" : "server";
}

export function resolveEnvironmentIconColor(
  color: EnvironmentIconColor | undefined,
  isKnownEnvironment: boolean,
): EnvironmentIconColor | undefined {
  return isKnownEnvironment ? color : undefined;
}

export function legacyThreadEnvironmentPresentation(input: {
  readonly isPrimary: boolean;
  readonly isDesktopLocal: boolean;
  readonly showLocalEnvironmentIcon: boolean;
  readonly environmentLabel: string | null | undefined;
}) {
  const kind = input.isPrimary ? ("monitor" as const) : ("server" as const);
  return {
    kind,
    showRowIcon: input.isPrimary ? input.showLocalEnvironmentIcon : !input.isDesktopLocal,
    hoverLabel: input.isPrimary
      ? input.showLocalEnvironmentIcon
        ? formatLocalEnvironmentLabel(input.environmentLabel)
        : null
      : (input.environmentLabel ?? (input.isDesktopLocal ? "Local" : "Remote")),
  };
}

export function showV2ThreadCardEnvironmentIcon(
  isPrimary: boolean,
  showLocalEnvironmentIcon: boolean,
): boolean {
  return !isPrimary || showLocalEnvironmentIcon;
}

export interface ProjectEnvironmentIconEntry {
  readonly environmentId: EnvironmentId;
  readonly kind: EnvironmentIconKind;
  readonly label: string;
}

export function projectEnvironmentIconEntries(input: {
  readonly members: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly environmentLabel: string | null;
  }>;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly desktopLocalEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly showLocalEnvironmentIcon: boolean;
}): ProjectEnvironmentIconEntry[] {
  const uniqueMembers = input.members.filter(
    (member, index, members) =>
      members.findIndex((candidate) => candidate.environmentId === member.environmentId) === index,
  );
  const orderedMembers = [
    ...uniqueMembers.filter((member) => member.environmentId === input.primaryEnvironmentId),
    ...uniqueMembers.filter((member) => member.environmentId !== input.primaryEnvironmentId),
  ];
  const isMixed = uniqueMembers.length > 1;

  return orderedMembers.flatMap((member): ProjectEnvironmentIconEntry[] => {
    if (member.environmentId === input.primaryEnvironmentId) {
      if (!input.showLocalEnvironmentIcon && !isMixed) return [];
      return [
        {
          environmentId: member.environmentId,
          kind: "monitor",
          label: formatLocalEnvironmentLabel(member.environmentLabel),
        },
      ];
    }
    if (input.desktopLocalEnvironmentIds.has(member.environmentId)) {
      return [
        {
          environmentId: member.environmentId,
          kind: "container",
          label: member.environmentLabel ?? "Local sandbox",
        },
      ];
    }
    return [
      {
        environmentId: member.environmentId,
        kind: "server",
        label: member.environmentLabel ?? "Remote",
      },
    ];
  });
}

export function EnvironmentIcon(props: {
  readonly kind: EnvironmentIconKind;
  readonly context: EnvironmentIconContext;
  readonly color?: EnvironmentIconColor | undefined;
  readonly className?: string | undefined;
  readonly style?: CSSProperties | undefined;
  readonly "aria-hidden"?: boolean | undefined;
}) {
  const Icon =
    props.kind === "monitor" ? MonitorIcon : props.kind === "server" ? ServerIcon : ContainerIcon;
  return (
    <Icon
      aria-hidden={props["aria-hidden"]}
      className={cn(
        props.color === undefined ? DEFAULT_CONTEXT_CLASS[props.context] : undefined,
        props.className,
      )}
      style={{ ...props.style, ...(props.color === undefined ? {} : { color: props.color }) }}
    />
  );
}
