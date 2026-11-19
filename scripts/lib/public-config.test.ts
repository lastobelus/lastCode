// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadRepoEnv } from "./public-config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("keeps source builds disabled and opts LastCode packages into public Connect defaults", () => {
    const repoRoot = makeTemporaryDirectory();
    expect(loadRepoEnv({ baseEnv: {}, repoRoot }).T3CODE_RELAY_URL).toBeUndefined();
    const packaged = loadRepoEnv({
      baseEnv: { LASTCODE_PUBLIC_CONNECT_DEFAULTS: "1" },
      repoRoot,
    });
    expect(loadRepoEnv({ baseEnv: packaged, repoRoot })).toEqual(packaged);
    expect(packaged).toMatchObject({
      T3CODE_CLERK_PUBLISHABLE_KEY: "pk_live_Y2xlcmsudDMuY29kZXMk",
      VITE_CLERK_PUBLISHABLE_KEY: "pk_live_Y2xlcmsudDMuY29kZXMk",
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_Y2xlcmsudDMuY29kZXMk",
      T3CODE_CLERK_JWT_TEMPLATE: "t3-relay",
      VITE_CLERK_JWT_TEMPLATE: "t3-relay",
      T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "hzxSgY2cH10sDU2r",
      VITE_CLERK_CLI_OAUTH_CLIENT_ID: "hzxSgY2cH10sDU2r",
      T3CODE_RELAY_URL: "https://relay.t3.codes",
      VITE_T3CODE_RELAY_URL: "https://relay.t3.codes",
    });
    expect(
      loadRepoEnv({ baseEnv: { LASTCODE_PUBLIC_CONNECT_DEFAULTS: "0" }, repoRoot })
        .T3CODE_RELAY_URL,
    ).toBeUndefined();
  });

  it.each([
    "T3CODE_CLERK_PUBLISHABLE_KEY",
    "VITE_CLERK_PUBLISHABLE_KEY",
    "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
    "T3CODE_CLERK_JWT_TEMPLATE",
    "VITE_CLERK_JWT_TEMPLATE",
    "EXPO_PUBLIC_CLERK_JWT_TEMPLATE",
    "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
    "VITE_CLERK_CLI_OAUTH_CLIENT_ID",
    "T3CODE_RELAY_URL",
    "VITE_T3CODE_RELAY_URL",
    "T3CODE_HOSTED_APP_URL",
  ])("suppresses the entire production fallback for an explicit %s", (key) => {
    const repoRoot = makeTemporaryDirectory();
    for (const value of ["custom", "", "  "]) {
      for (const source of ["process", ".env", ".env.local"]) {
        const baseEnv = {
          LASTCODE_PUBLIC_CONNECT_DEFAULTS: "1",
          ...(source === "process" ? { [key]: value } : {}),
        };
        if (source !== "process") {
          NodeFS.writeFileSync(NodePath.join(repoRoot, source), `${key}=${value}\n`);
        }
        const env = loadRepoEnv({ baseEnv, repoRoot });
        expect(env.T3CODE_CLERK_PUBLISHABLE_KEY).not.toBe("pk_live_Y2xlcmsudDMuY29kZXMk");
        expect(env.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID).not.toBe("hzxSgY2cH10sDU2r");
        expect(env.T3CODE_CLERK_JWT_TEMPLATE).not.toBe("t3-relay");
        expect(env.T3CODE_RELAY_URL).not.toBe("https://relay.t3.codes");
        if (source !== "process") NodeFS.rmSync(NodePath.join(repoRoot, source));
      }
    }
  });

  it("applies process, root local, and root precedence in that order", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "T3CODE_CLERK_PUBLISHABLE_KEY=pk_root\nT3CODE_CLERK_JWT_TEMPLATE=template_root\nT3CODE_CLERK_CLI_OAUTH_CLIENT_ID=oauth_root\nT3CODE_RELAY_URL=https://root.example.test\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "T3CODE_CLERK_PUBLISHABLE_KEY=pk_local\nT3CODE_CLERK_JWT_TEMPLATE=template_local\nT3CODE_CLERK_CLI_OAUTH_CLIENT_ID=oauth_local\nT3CODE_RELAY_URL=https://local.example.test\n",
    );

    expect(loadRepoEnv({ baseEnv: {}, repoRoot }).T3CODE_RELAY_URL).toBe(
      "https://local.example.test",
    );
    expect(
      loadRepoEnv({
        baseEnv: {
          LASTCODE_PUBLIC_CONNECT_DEFAULTS: "1",
          T3CODE_CLERK_PUBLISHABLE_KEY: "pk_ci",
          T3CODE_CLERK_JWT_TEMPLATE: "template_ci",
          T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
          T3CODE_RELAY_URL: "https://ci.example.test",
        },
        repoRoot,
      }),
    ).toMatchObject({
      T3CODE_CLERK_PUBLISHABLE_KEY: "pk_ci",
      T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
      VITE_CLERK_PUBLISHABLE_KEY: "pk_ci",
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_ci",
      T3CODE_CLERK_JWT_TEMPLATE: "template_ci",
      VITE_CLERK_JWT_TEMPLATE: "template_ci",
      EXPO_PUBLIC_CLERK_JWT_TEMPLATE: "template_ci",
      T3CODE_RELAY_URL: "https://ci.example.test",
      VITE_T3CODE_RELAY_URL: "https://ci.example.test",
    });
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
