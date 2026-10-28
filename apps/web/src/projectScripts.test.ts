import { shortcutLabelForCommand } from "./keybindings";
import { describe, expect, it } from "vite-plus/test";
import { settleProjectScript, setupProjectScript } from "@t3tools/shared/projectScripts";

import {
  buildProjectScript,
  selectProjectScriptTerminal,
  commandForProjectScript,
  projectScriptIdFromCommand,
  nextProjectScriptId,
  primaryProjectScript,
  releaseClaimedRoles,
} from "./projectScripts";

describe("projectScripts helpers", () => {
  it.each([false, true])("records agent resume only when enabled: %s", (allowAgentResume) => {
    const script = buildProjectScript("check", {
      name: "Check project",
      command: "pnpm test",
      icon: "test",
      runOnWorktreeCreate: false,
      waitForSetup: false,
      runOnSettle: false,
      previewUrl: null,
      autoOpenPreview: false,
      allowAgentResume,
    });
    if (allowAgentResume) expect(script.allowAgentResume).toBe(true);
    else expect(script).not.toHaveProperty("allowAgentResume");
  });

  it("builds and parses script run commands", () => {
    const command = commandForProjectScript("lint");
    expect(command).toBe("script.lint.run");
    expect(projectScriptIdFromCommand(command ?? "")).toBe("lint");

    const externalId = "123e4567-e89b-42d3-a456-426614174000";
    const externalCommand = commandForProjectScript(externalId);
    expect(externalCommand).toBe(`script.${externalId}.run`);
    expect(projectScriptIdFromCommand(externalCommand ?? "")).toBe(externalId);

    expect(projectScriptIdFromCommand("script. lint .run")).toBeNull();
    expect(projectScriptIdFromCommand("terminal.toggle")).toBeNull();
  });

  it.each(["install-javascript-dependencies", "A", "a.b", "a b", "-a", "a".repeat(25)])(
    "round-trips supported external script ID %j",
    (id) => {
      const command = commandForProjectScript(id);
      expect(command).toBe(`script.${id}.run`);
      expect(projectScriptIdFromCommand(command ?? "")).toBe(id);
    },
  );

  it.each(["", " ", " lint", "lint "])(
    "omits the shortcut for legacy script ID %j without crashing script menus",
    (id) => {
      const commands = ["lint", id, "test"].map(commandForProjectScript);
      expect(commands).toEqual(["script.lint.run", null, "script.test.run"]);
      expect(commands.map((command) => shortcutLabelForCommand([], command))).toEqual([
        null,
        null,
        null,
      ]);
    },
  );

  it("slugifies and dedupes project script ids", () => {
    expect(nextProjectScriptId("Run Tests", [])).toBe("run-tests");
    expect(nextProjectScriptId("Run Tests", ["run-tests"])).toBe("run-tests-2");
    expect(nextProjectScriptId("!!!", [])).toBe("script");
  });

  it("resolves primary, setup, and settle scripts", () => {
    const scripts = [
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure" as const,
        runOnWorktreeCreate: true,
      },
      {
        id: "clean",
        name: "Clean",
        command: "cargo clean",
        icon: "build" as const,
        runOnWorktreeCreate: false,
        runOnSettle: true,
      },
      {
        id: "test",
        name: "Test",
        command: "bun test",
        icon: "test" as const,
        runOnWorktreeCreate: false,
      },
    ];

    expect(primaryProjectScript(scripts)?.id).toBe("test");
    expect(setupProjectScript(scripts)?.id).toBe("setup");
    expect(settleProjectScript(scripts)?.id).toBe("clean");
    expect(primaryProjectScript(scripts.filter((script) => script.id === "clean"))).toBeNull();
  });

  it("moves the setup and settle roles to the script that claims them", () => {
    const input = {
      name: "Next",
      command: "true",
      icon: "play",
      waitForSetup: false,
      previewUrl: null,
      autoOpenPreview: false,
    } as const;
    const holder = {
      id: "holder",
      name: "Holder",
      command: "true",
      icon: "play" as const,
      runOnWorktreeCreate: true,
      runOnSettle: true,
    };

    expect(
      releaseClaimedRoles(holder, { ...input, runOnWorktreeCreate: false, runOnSettle: true }),
    ).toMatchObject({ runOnWorktreeCreate: true, runOnSettle: false });
    expect(
      releaseClaimedRoles(holder, { ...input, runOnWorktreeCreate: true, runOnSettle: false }),
    ).toMatchObject({ runOnWorktreeCreate: false, runOnSettle: true });
    expect(
      releaseClaimedRoles(holder, { ...input, runOnWorktreeCreate: false, runOnSettle: false }),
    ).toBe(holder);
  });
});

describe("Action terminal selection", () => {
  const ordinary = {
    id: "check",
    name: "Check",
    command: "echo ready",
    icon: "test",
    runOnWorktreeCreate: false,
  } as const;
  const base = {
    script: ordinary,
    baseTerminalId: "term-1",
    isBaseTerminalBusy: false,
    preferNewTerminal: false,
    canReuseTerminal: true,
    canReadTerminal: true,
    allocateTerminalId: () => "term-2",
  };

  it("isolates named-profile output and keeps the next ordinary Action out of that terminal", () => {
    const action = selectProjectScriptTerminal({
      ...base,
      script: { ...ordinary, terminalLinkProfileName: "Work account" },
    });
    expect(action).toEqual({
      createNewTerminal: true,
      terminalId: expect.stringMatching(/^term-2-[0-9a-f-]{36}$/u),
      terminalLinkProfileName: "Work account",
    });
    const next = selectProjectScriptTerminal({
      ...base,
      baseTerminalId: action.terminalId,
      baseTerminalLinkProfileName: action.terminalLinkProfileName,
      allocateTerminalId: () => "term-3",
    });
    expect(next).toEqual({ createNewTerminal: true, terminalId: "term-3" });
    expect(selectProjectScriptTerminal(base)).toEqual({
      createNewTerminal: false,
      terminalId: "term-1",
    });
  });

  it("allocates different opted-in terminals for clients with the same stale numeric snapshot", () => {
    const action = { ...ordinary, terminalLinkProfileName: "Work account" };
    const first = selectProjectScriptTerminal({ ...base, script: action });
    const second = selectProjectScriptTerminal({
      ...base,
      script: { ...action, terminalLinkProfileName: "Other account" },
    });
    expect(first.terminalId).not.toBe(second.terminalId);
    expect(first.terminalId).not.toBe("term-2");
    expect(second.terminalId).not.toBe("term-2");
    expect(first.terminalLinkProfileName).toBe("Work account");
    expect(second.terminalLinkProfileName).toBe("Other account");
    expect(selectProjectScriptTerminal(base)).toEqual({
      createNewTerminal: false,
      terminalId: "term-1",
    });
  });

  it.each([
    { isBaseTerminalBusy: true },
    { preferNewTerminal: true },
    { canReuseTerminal: false },
    { canReadTerminal: false },
  ])("preserves ordinary Action allocation constraints: %j", (constraint) => {
    expect(selectProjectScriptTerminal({ ...base, ...constraint })).toEqual({
      createNewTerminal: true,
      terminalId: "term-2",
    });
  });

  it("preserves explicit intent when building an imported Action", () => {
    expect(
      buildProjectScript("check", {
        ...ordinary,
        waitForSetup: false,
        runOnSettle: false,
        previewUrl: null,
        autoOpenPreview: false,
        terminalLinkProfileName: "Work account",
      }),
    ).toMatchObject({ terminalLinkProfileName: "Work account" });
  });
});
