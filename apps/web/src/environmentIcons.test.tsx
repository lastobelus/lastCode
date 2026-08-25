import { EnvironmentId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  EnvironmentIcon,
  environmentIconKind,
  formatLocalEnvironmentLabel,
  legacyThreadEnvironmentPresentation,
  normalizeEnvironmentIconColor,
  projectEnvironmentIconEntries,
  resolveEnvironmentIconColor,
  showV2ThreadCardEnvironmentIcon,
  updateEnvironmentIconColors,
} from "./environmentIcons";

const local = EnvironmentId.make("local");
const buildbox = EnvironmentId.make("buildbox");
const production = EnvironmentId.make("production");
const wsl = EnvironmentId.make("wsl");

describe("environment icon preferences", () => {
  it("normalizes custom colors and removes an entry for Default", () => {
    expect(normalizeEnvironmentIconColor(" #7C3AED ")).toBe("#7c3aed");
    expect(normalizeEnvironmentIconColor("purple")).toBeUndefined();
    expect(updateEnvironmentIconColors({}, buildbox, "#2563EB")).toEqual({
      buildbox: "#2563eb",
    });
    expect(updateEnvironmentIconColors({ buildbox: "#2563eb" }, buildbox, "")).toEqual({});
  });

  it("uses absolute Monitor and Server identity", () => {
    expect(environmentIconKind(local, local)).toBe("monitor");
    expect(environmentIconKind(buildbox, local)).toBe("server");
    expect(environmentIconKind(local, buildbox)).toBe("server");
  });

  it("falls back to Default for a deleted or unknown environment", () => {
    expect(resolveEnvironmentIconColor("#2563eb", true)).toBe("#2563eb");
    expect(resolveEnvironmentIconColor("#2563eb", false)).toBeUndefined();
  });

  it("defines Legacy row slots and hover lines for local, remote, and desktop-local threads", () => {
    expect(
      legacyThreadEnvironmentPresentation({
        isPrimary: true,
        isDesktopLocal: false,
        showLocalEnvironmentIcon: false,
        environmentLabel: "Airy",
      }),
    ).toEqual({ kind: "monitor", showRowIcon: false, hoverLabel: null });
    expect(
      legacyThreadEnvironmentPresentation({
        isPrimary: true,
        isDesktopLocal: false,
        showLocalEnvironmentIcon: true,
        environmentLabel: "Airy",
      }),
    ).toEqual({ kind: "monitor", showRowIcon: true, hoverLabel: "Airy (local)" });
    expect(
      legacyThreadEnvironmentPresentation({
        isPrimary: false,
        isDesktopLocal: false,
        showLocalEnvironmentIcon: false,
        environmentLabel: "Buildbox",
      }),
    ).toEqual({ kind: "server", showRowIcon: true, hoverLabel: "Buildbox" });
  });

  it("shows the V2 local card icon only after opt-in while always showing remotes", () => {
    expect(showV2ThreadCardEnvironmentIcon(true, false)).toBe(false);
    expect(showV2ThreadCardEnvironmentIcon(true, true)).toBe(true);
    expect(showV2ThreadCardEnvironmentIcon(false, false)).toBe(true);
  });

  it("formats the resolved local label with a safe fallback", () => {
    expect(formatLocalEnvironmentLabel("Airy")).toBe("Airy (local)");
    expect(formatLocalEnvironmentLabel(" ")).toBe("Local (local)");
  });
});

describe("project environment icons", () => {
  const member = (environmentId: EnvironmentId, environmentLabel: string | null) => ({
    environmentId,
    environmentLabel,
  });

  it("hides a local-only icon by default and shows it after opt-in", () => {
    const base = {
      members: [member(local, "Airy")],
      primaryEnvironmentId: local,
      desktopLocalEnvironmentIds: new Set<EnvironmentId>(),
    };
    expect(projectEnvironmentIconEntries({ ...base, showLocalEnvironmentIcon: false })).toEqual([]);
    expect(projectEnvironmentIconEntries({ ...base, showLocalEnvironmentIcon: true })).toEqual([
      { environmentId: local, kind: "monitor", label: "Airy (local)" },
    ]);
  });

  it("shows each unique mixed environment with local first even when local is hidden", () => {
    expect(
      projectEnvironmentIconEntries({
        members: [
          member(buildbox, "Buildbox"),
          member(local, "Airy"),
          member(buildbox, "Buildbox"),
          member(production, "Production"),
          member(wsl, "Ubuntu"),
        ],
        primaryEnvironmentId: local,
        desktopLocalEnvironmentIds: new Set([wsl]),
        showLocalEnvironmentIcon: false,
      }),
    ).toEqual([
      { environmentId: local, kind: "monitor", label: "Airy (local)" },
      { environmentId: buildbox, kind: "server", label: "Buildbox" },
      { environmentId: production, kind: "server", label: "Production" },
      { environmentId: wsl, kind: "container", label: "Ubuntu" },
    ]);
  });
});

describe("EnvironmentIcon", () => {
  it("keeps semantic context styling for Default", () => {
    const markup = renderToStaticMarkup(
      <EnvironmentIcon kind="server" context="legacy-row" className="size-3" />,
    );
    expect(markup).toContain("text-muted-foreground/40");
    expect(markup).not.toContain("style=");
  });

  it("uses an explicit color without the contextual opacity class", () => {
    const markup = renderToStaticMarkup(
      <EnvironmentIcon kind="monitor" context="v2-row" color="#2563eb" className="size-3" />,
    );
    expect(markup).toContain("color:#2563eb");
    expect(markup).not.toContain("text-sidebar-muted-foreground/70");
  });
});
