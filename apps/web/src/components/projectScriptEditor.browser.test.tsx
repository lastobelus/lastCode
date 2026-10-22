import { act, render, type Screen } from "../../test/render";
import { EnvironmentId, ProjectScript } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
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

function request(name: string, error?: string): ProjectScriptEditorRequest {
  return {
    scriptId: name,
    initial: { ...EMPTY_PROJECT_SCRIPT_INPUT, name, command: `run-${name}` },
    ...(error === undefined ? {} : { error }),
  };
}

const open = (screen: Screen, nextRequest: ProjectScriptEditorRequest) =>
  screen.rerender(
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
  );

const submit = () => document.querySelector("form")!.requestSubmit();
const saveButton = () => document.querySelector<HTMLButtonElement>('button[type="submit"]')!;

async function fillInput(selector: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(selector)!;
  await userEvent.clear(input);
  if (value !== "") await userEvent.type(input, value);
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

function setup() {
  onSubmit.mockReset();
  onClose.mockReset();
  onDelete.mockReset();
}

describe("project action editor save lifecycle", () => {
  it("preserves declared terminal profile intent while editing other Action settings", async () => {
    setup();
    await using screen = await render(null);
    onSubmit.mockResolvedValue(AsyncResult.success(undefined));
    const editing = request("sign-in");
    await open(screen, {
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
      setup();
      await using screen = await render(null);
      onSubmit.mockResolvedValue(AsyncResult.success(undefined));
      const editing = request("sign-in");
      await open(screen, {
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
    setup();
    await using screen = await render(null);
    onSubmit.mockResolvedValue(AsyncResult.success(undefined));
    const editing = request("sign-in");
    await open(screen, {
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
    setup();
    await using screen = await render(null);
    onSubmit.mockResolvedValue(AsyncResult.success(undefined));
    const first = request("sign-in");
    await open(screen, {
      ...first,
      initial: { ...first.initial, terminalLinkProfileName: "Work account" },
    });
    await fillInput("#script-terminal-link-profile", "Unsaved account");
    await open(screen, request("build"));
    await act(async () => {
      await submit();
    });
    expect(onSubmit.mock.calls[0]![1]).not.toHaveProperty("terminalLinkProfileName");
  });

  it("does not close a replacement request or release its in-flight save", async () => {
    setup();
    await using screen = await render(null);
    const first = deferredSave();
    const second = deferredSave();
    onSubmit.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await open(screen, request("build"));
    await act(async () => submit());

    await open(screen, request("test"));
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
});
