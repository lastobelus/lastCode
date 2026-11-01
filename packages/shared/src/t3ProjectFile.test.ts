import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { parseT3ProjectFile, T3ProjectFileFromJson } from "./t3ProjectFile.ts";

const decodeJson = Schema.decodeUnknownSync(T3ProjectFileFromJson);

describe("T3ProjectFileFromJson", () => {
  it("decodes lenient JSONC with comments and trailing commas", () => {
    const decoded = decodeJson(`{
      // team scripts
      "iconPath": "assets/logo.svg",
      "scripts": [
        { "id": "dev-server", "name": "Dev", "command": "pnpm dev", },
      ],
    }`);

    expect(decoded.iconPath).toBe("assets/logo.svg");
    expect(decoded.scripts?.[0]).toEqual({ id: "dev-server", name: "Dev", command: "pnpm dev" });
  });
});

describe("parseT3ProjectFile", () => {
  it("reads project defaults from JSONC with a URL in a block comment", () => {
    expect(
      parseT3ProjectFile(`{
        /* See https://t3.codes/schema/t3.json */
        "defaultThreadEnvMode": "worktree"
      }`),
    ).toEqual({ defaultThreadEnvMode: "worktree" });
  });
});

it("rejects an invalid stable script id from project JSON", () => {
  expect(
    parseT3ProjectFile('{"scripts":[{"id":"Dev Server","name":"Dev","command":"pnpm dev"}]}'),
  ).toBeNull();
});

it("decodes explicit terminal-link intent without an embedded URL", () => {
  expect(
    decodeJson(
      '{ "scripts": [{ "name": "Sign in", "command": "auth-tool login", "terminalLinkProfileName": "Work account" }] }',
    ).scripts?.[0]?.terminalLinkProfileName,
  ).toBe("Work account");
});
