import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
  type ConnectionCatalogEntry,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { desktopLocalConnectionId } from "../../connection/desktopLocal";
import { deriveLastCodeEnvironmentSettingEntries } from "./LastCodeSettings.logic";

const primary = EnvironmentId.make("primary");
const buildbox = EnvironmentId.make("buildbox");
const production = EnvironmentId.make("production");
const ssh = EnvironmentId.make("ssh");
const wsl = EnvironmentId.make("wsl");

function entry(target: ConnectionCatalogEntry["target"]): ConnectionCatalogEntry {
  return { target, profile: Option.none() };
}

describe("deriveLastCodeEnvironmentSettingEntries", () => {
  it("lists local first and includes every saved remote in catalog order", () => {
    const entries = new Map<EnvironmentId, ConnectionCatalogEntry>([
      [
        production,
        entry(new RelayConnectionTarget({ environmentId: production, label: "Production" })),
      ],
      [
        primary,
        entry(
          new PrimaryConnectionTarget({
            environmentId: primary,
            label: "Airy",
            httpBaseUrl: "http://localhost",
            wsBaseUrl: "ws://localhost/ws",
          }),
        ),
      ],
      [
        buildbox,
        entry(
          new BearerConnectionTarget({
            environmentId: buildbox,
            label: "Buildbox",
            connectionId: "buildbox",
          }),
        ),
      ],
      [
        ssh,
        entry(
          new SshConnectionTarget({
            environmentId: ssh,
            label: "SSH Lab",
            connectionId: "ssh-lab",
          }),
        ),
      ],
    ]);

    expect(
      deriveLastCodeEnvironmentSettingEntries({ entries, primaryEnvironmentId: primary }),
    ).toEqual([
      { environmentId: primary, kind: "local", label: "Airy (local)" },
      { environmentId: production, kind: "remote", label: "Production" },
      { environmentId: buildbox, kind: "remote", label: "Buildbox" },
      { environmentId: ssh, kind: "remote", label: "SSH Lab" },
    ]);
  });

  it("omits desktop-local secondary environments", () => {
    const entries = new Map<EnvironmentId, ConnectionCatalogEntry>([
      [
        wsl,
        entry(
          new BearerConnectionTarget({
            environmentId: wsl,
            label: "Ubuntu",
            connectionId: desktopLocalConnectionId("wsl:ubuntu"),
          }),
        ),
      ],
    ]);
    expect(
      deriveLastCodeEnvironmentSettingEntries({ entries, primaryEnvironmentId: primary }),
    ).toEqual([{ environmentId: primary, kind: "local", label: "Local (local)" }]);
  });
});
