import type { KeybindingCommand } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { commandForProjectScript } from "../projectScripts";
import {
  decodeProjectScriptKeybindingRule,
  keybindingValueForCommand,
  PROJECT_SCRIPT_KEYBINDING_INVALID_MESSAGE,
} from "./projectScriptKeybindings";

describe("projectScriptKeybindings", () => {
  it("rejects invalid commands", () => {
    expect(() =>
      decodeProjectScriptKeybindingRule({
        keybinding: "mod+k",
        command: "script..run" as KeybindingCommand,
      }),
    ).toThrowError(PROJECT_SCRIPT_KEYBINDING_INVALID_MESSAGE);
  });

  it("supports adding a shortcut to an externally supplied script ID", () => {
    const command = commandForProjectScript("install-javascript-dependencies");
    expect(keybindingValueForCommand([], command)).toBeNull();
    expect(decodeProjectScriptKeybindingRule({ keybinding: null, command })).toBeNull();
    expect(decodeProjectScriptKeybindingRule({ keybinding: "mod+k", command })).toEqual({
      key: "mod+k",
      command: "script.install-javascript-dependencies.run",
    });
  });

  it("can edit or delete an invalid script without assigning a shortcut", () => {
    const command = commandForProjectScript("");
    expect(command).toBeNull();
    expect(keybindingValueForCommand([], command)).toBeNull();
    expect(decodeProjectScriptKeybindingRule({ keybinding: null, command })).toBeNull();
    expect(() => decodeProjectScriptKeybindingRule({ keybinding: "mod+k", command })).toThrowError(
      PROJECT_SCRIPT_KEYBINDING_INVALID_MESSAGE,
    );
  });
});
