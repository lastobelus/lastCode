import { EnvironmentId, ProjectScript } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { buildProjectScript } from "~/projectScripts";

vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));

import {
  EMPTY_PROJECT_SCRIPT_INPUT,
  ProjectScriptEditorDialog,
  type ProjectScriptActionResult,
  type ProjectScriptEditorRequest,
} from "./projectScriptEditor";

const savedActionJson = Schema.fromJsonString(ProjectScript);
const encodeSavedAction = Schema.encodeSync(savedActionJson);
const decodeSavedAction = Schema.decodeUnknownSync(savedActionJson);

const onSubmit = vi.fn<Parameters<typeof ProjectScriptEditorDialog>[0]["onSubmit"]>();
const onClose = vi.fn();
const onDelete = vi.fn();
let root: Root;
let mounted: boolean;

function request(name: string, error?: string): ProjectScriptEditorRequest {
  return {
    scriptId: name,
    initial: { ...EMPTY_PROJECT_SCRIPT_INPUT, name, command: `run-${name}` },
    ...(error === undefined ? {} : { error }),
  };
}

const open = (nextRequest: ProjectScriptEditorRequest) =>
  act(async () =>
    root.render(
      <StrictMode>
        <ProjectScriptEditorDialog
          environmentId={EnvironmentId.make("test")}
          request={nextRequest}
          scripts={[]}
          onSubmit={onSubmit}
          onClose={onClose}
          onDelete={onDelete}
        />
      </StrictMode>,
    ),
  );

const submit = () => document.querySelector("form")!.requestSubmit();
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((element) => element.textContent === label)!;
const saveButton = () => document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
const fieldset = () => document.querySelector("fieldset")!;
const messages = () => [...document.querySelectorAll("form p")].map((p) => p.textContent);

async function fillInput(selector: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(selector)!;
  await act(async () => {
    await userEvent.clear(input);
    if (value !== "") await userEvent.type(input, value);
  });
}

function deferredSave() {
  let resolve!: (result: ProjectScriptActionResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ProjectScriptActionResult>((resolveResult, rejectResult) => {
    resolve = resolveResult;
    reject = rejectResult;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onSubmit.mockReset();
  onClose.mockReset();
  onDelete.mockReset();
  root = createRoot(document.createElement("div"));
  mounted = true;
});

afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("project action editor save lifecycle", () => {
  it("preserves declared terminal profile intent while editing other Action settings", async () => {
    onSubmit.mockResolvedValue(AsyncResult.success(undefined));
    const editing = request("sign-in");
    await open({
      ...editing,
      initial: { ...editing.initial, terminalLinkProfileName: "Work account" },
    });
    await fillInput("#script-name", "Updated sign-in");
    await act(async () => {
      await submit();
    });
    const saved = buildProjectScript(editing.scriptId!, onSubmit.mock.calls[0]![1]);
    expect(saved.name).toBe("Updated sign-in");
    expect(saved.terminalLinkProfileName).toBe("Work account");
  });

  it.each([
    { initial: undefined, edited: "", expected: undefined },
    { initial: undefined, edited: " Work account ", expected: "Work account" },
    { initial: "Work account", edited: " Other account ", expected: "Other account" },
    { initial: "Work account", edited: "", expected: undefined },
    { initial: "Work account", edited: "   ", expected: undefined },
  ])(
    "saves edited terminal profile intent: $initial → $expected",
    async ({ initial, edited, expected }) => {
      onSubmit.mockResolvedValue(AsyncResult.success(undefined));
      const editing = request("sign-in");
      await open({
        ...editing,
        initial: {
          ...editing.initial,
          ...(initial === undefined ? {} : { terminalLinkProfileName: initial }),
        },
      });
      await fillInput("#script-terminal-link-profile", edited);
      await act(async () => {
        await submit();
      });
      const payload = onSubmit.mock.calls[0]![1];
      const saved = encodeSavedAction(buildProjectScript(editing.scriptId!, payload));
      const restored = decodeSavedAction(saved);
      if (expected === undefined) {
        expect(payload).not.toHaveProperty("terminalLinkProfileName");
        expect(restored).not.toHaveProperty("terminalLinkProfileName");
      } else {
        expect(restored.terminalLinkProfileName).toBe(expected);
      }
    },
  );

  it("clears an imported terminal profile using the editor reset control", async () => {
    onSubmit.mockResolvedValue(AsyncResult.success(undefined));
    const editing = request("sign-in");
    await open({
      ...editing,
      initial: { ...editing.initial, terminalLinkProfileName: "Work account" },
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[aria-label="Clear terminal link profile"]')!
        .click();
    });
    await act(async () => {
      await submit();
    });
    expect(buildProjectScript(editing.scriptId!, onSubmit.mock.calls[0]![1])).not.toHaveProperty(
      "terminalLinkProfileName",
    );
  });

  it("hydrates a replacement Action's profile without retaining unsaved edits", async () => {
    onSubmit.mockResolvedValue(AsyncResult.success(undefined));
    const first = request("sign-in");
    await open({
      ...first,
      initial: { ...first.initial, terminalLinkProfileName: "Work account" },
    });
    await fillInput("#script-terminal-link-profile", "Unsaved account");
    await open(request("build"));
    await act(async () => {
      await submit();
    });
    expect(onSubmit.mock.calls[0]![1]).not.toHaveProperty("terminalLinkProfileName");
  });

  it("blocks repeated submits and edits until the current save completes", async () => {
    const save = deferredSave();
    onSubmit.mockReturnValue(save.promise);
    await open(request("build"));

    await act(async () => {
      submit();
      submit();
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(saveButton().disabled).toBe(true);
    expect(saveButton().textContent).toBe("Saving…");
    expect(fieldset().disabled).toBe(true);
    expect(button("Cancel").disabled).toBe(false);

    await act(async () => save.resolve(AsyncResult.success(undefined)));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close a replacement request or release its in-flight save", async () => {
    const first = deferredSave();
    const second = deferredSave();
    onSubmit.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await open(request("build"));
    await act(async () => submit());

    await open(request("test"));
    expect(saveButton().disabled).toBe(false);
    expect(document.querySelector<HTMLInputElement>("#script-name")!.value).toBe("test");
    await act(async () => submit());

    await act(async () => first.resolve(AsyncResult.success(undefined)));
    expect(onClose).not.toHaveBeenCalled();
    expect(saveButton().disabled).toBe(true);

    await act(async () => second.resolve(AsyncResult.success(undefined)));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls.map(([scriptId]) => scriptId)).toEqual(["build", "test"]);
  });

  it.each(["failure", "rejection"] as const)(
    "ignores a stale %s after the request changes",
    async (outcome) => {
      const save = deferredSave();
      onSubmit.mockReturnValue(save.promise);
      await open(request("build"));
      await act(async () => submit());

      await open(request("test", "New request error"));
      await act(async () => {
        if (outcome === "failure")
          save.resolve(AsyncResult.failure(Cause.fail(new Error("Old save error"))));
        else save.reject(new Error("Old save error"));
      });

      expect(messages()).toContain("New request error");
      expect(messages()).not.toContain("Old save error");
      expect(saveButton().disabled).toBe(false);
      expect(onClose).not.toHaveBeenCalled();
    },
  );

  it("shows a current save error and allows retry", async () => {
    onSubmit.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Save failed"))));
    onSubmit.mockResolvedValueOnce(AsyncResult.success(undefined));
    await open(request("build"));

    await act(async () => saveButton().click());
    expect(messages()).toContain("Save failed");
    expect(saveButton().disabled).toBe(false);
    expect(fieldset().disabled).toBe(false);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => saveButton().click());
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each(["cancel", "unmount"] as const)("ignores save completion after %s", async (exit) => {
    const save = deferredSave();
    onSubmit.mockReturnValue(save.promise);
    await open(request("build"));
    await act(async () => submit());

    await act(async () => {
      if (exit === "cancel") button("Cancel").click();
      else {
        root.unmount();
        mounted = false;
      }
    });
    onClose.mockClear();
    await act(async () => save.resolve(AsyncResult.success(undefined)));
    expect(onClose).not.toHaveBeenCalled();
  });
});
