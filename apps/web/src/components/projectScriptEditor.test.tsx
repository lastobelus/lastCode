import { EnvironmentId, ProjectScript } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act, StrictMode, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/state/session", () => ({
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock("./ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? children : null),
  DialogDescription: "p",
  DialogFooter: "footer",
  DialogHeader: "header",
  DialogPanel: "section",
  DialogPopup: "section",
  DialogTitle: "h2",
}));
vi.mock("./ui/alert-dialog", () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? children : null,
  AlertDialogClose: "button",
  AlertDialogDescription: "p",
  AlertDialogFooter: "footer",
  AlertDialogHeader: "header",
  AlertDialogPopup: "section",
  AlertDialogTitle: "h2",
}));
vi.mock("./ui/button", () => ({ Button: "button" }));
vi.mock("./ui/input", () => ({ Input: "input" }));
vi.mock("./ui/label", () => ({ Label: "label" }));
vi.mock("./ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverPopup: () => null,
  PopoverTrigger: "button",
}));
vi.mock("./ui/switch", () => ({ Switch: "input" }));
vi.mock("./ui/textarea", () => ({ Textarea: "textarea" }));

import { buildProjectScript } from "~/projectScripts";

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
let renderer: ReactTestRenderer | null;

function request(name: string, error?: string): ProjectScriptEditorRequest {
  return {
    scriptId: name,
    initial: { ...EMPTY_PROJECT_SCRIPT_INPUT, name, command: `run-${name}` },
    ...(error === undefined ? {} : { error }),
  };
}

function editor(nextRequest: ProjectScriptEditorRequest) {
  return (
    <StrictMode>
      <ProjectScriptEditorDialog
        environmentId={EnvironmentId.make("test")}
        request={nextRequest}
        scripts={[]}
        onSubmit={onSubmit}
        onClose={onClose}
        onDelete={onDelete}
      />
    </StrictMode>
  );
}

function open(nextRequest: ProjectScriptEditorRequest) {
  act(() => {
    if (renderer) renderer.update(editor(nextRequest));
    else renderer = create(editor(nextRequest));
  });
}

function submit(): Promise<void> {
  return renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} });
}

function saveButton() {
  return renderer!.root.findAllByType("button").find((button) => button.props.type === "submit")!;
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
  renderer = null;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onSubmit.mockReset();
  onClose.mockReset();
  onDelete.mockReset();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

describe("project action editor save lifecycle", () => {
  it("preserves declared terminal profile intent while editing other Action settings", async () => {
    onSubmit.mockResolvedValue(AsyncResult.success(undefined));
    const editing = request("sign-in");
    open({ ...editing, initial: { ...editing.initial, terminalLinkProfileName: "Work account" } });
    act(() => {
      renderer!.root.findByProps({ id: "script-name" }).props.onChange({
        target: { value: "Updated sign-in" },
      });
    });
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
      open({
        ...editing,
        initial: {
          ...editing.initial,
          ...(initial === undefined ? {} : { terminalLinkProfileName: initial }),
        },
      });
      act(() => {
        renderer!.root.findByProps({ id: "script-terminal-link-profile" }).props.onChange({
          target: { value: edited },
        });
      });
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
    open({ ...editing, initial: { ...editing.initial, terminalLinkProfileName: "Work account" } });
    act(() => {
      renderer!.root.findByProps({ "aria-label": "Clear terminal link profile" }).props.onClick();
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
    open({ ...first, initial: { ...first.initial, terminalLinkProfileName: "Work account" } });
    act(() => {
      renderer!.root.findByProps({ id: "script-terminal-link-profile" }).props.onChange({
        target: { value: "Unsaved account" },
      });
    });
    open(request("build"));
    await act(async () => {
      await submit();
    });
    expect(onSubmit.mock.calls[0]![1]).not.toHaveProperty("terminalLinkProfileName");
  });

  it("blocks repeated submits and edits until the current save completes", async () => {
    const save = deferredSave();
    onSubmit.mockReturnValue(save.promise);
    open(request("build"));

    let completion!: Promise<void>;
    act(() => {
      completion = submit();
      void submit();
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(saveButton().props.disabled).toBe(true);
    expect(renderer!.root.findByType("fieldset").props.disabled).toBe(true);
    const cancel = renderer!.root
      .findAllByType("button")
      .find((button) => button.children.includes("Cancel"))!;
    expect(cancel.props.disabled).not.toBe(true);

    await act(async () => {
      save.resolve(AsyncResult.success(undefined));
      await completion;
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close a replacement request or release its in-flight save", async () => {
    const first = deferredSave();
    const second = deferredSave();
    onSubmit.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    open(request("build"));
    let firstCompletion!: Promise<void>;
    act(() => {
      firstCompletion = submit();
    });

    open(request("test"));
    expect(saveButton().props.disabled).toBe(false);
    expect(renderer!.root.findByProps({ id: "script-name" }).props.value).toBe("test");
    let secondCompletion!: Promise<void>;
    act(() => {
      secondCompletion = submit();
    });

    await act(async () => {
      first.resolve(AsyncResult.success(undefined));
      await firstCompletion;
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(saveButton().props.disabled).toBe(true);

    await act(async () => {
      second.resolve(AsyncResult.success(undefined));
      await secondCompletion;
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls.map(([scriptId]) => scriptId)).toEqual(["build", "test"]);
  });

  it.each(["failure", "rejection"] as const)(
    "ignores a stale %s after the request changes",
    async (outcome) => {
      const save = deferredSave();
      onSubmit.mockReturnValue(save.promise);
      open(request("build"));
      let completion!: Promise<void>;
      act(() => {
        completion = submit();
      });

      open(request("test", "New request error"));
      await act(async () => {
        if (outcome === "failure")
          save.resolve(AsyncResult.failure(Cause.fail(new Error("Old save error"))));
        else save.reject(new Error("Old save error"));
        await completion;
      });

      const messages = renderer!.root.findAllByType("p").flatMap((paragraph) => paragraph.children);
      expect(messages).toContain("New request error");
      expect(messages).not.toContain("Old save error");
      expect(saveButton().props.disabled).toBe(false);
      expect(onClose).not.toHaveBeenCalled();
    },
  );

  it("shows a current save error and allows retry", async () => {
    onSubmit.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Save failed"))));
    onSubmit.mockResolvedValueOnce(AsyncResult.success(undefined));
    open(request("build"));

    await act(async () => {
      await submit();
    });
    expect(renderer!.root.findAllByType("p").flatMap((paragraph) => paragraph.children)).toContain(
      "Save failed",
    );
    expect(saveButton().props.disabled).toBe(false);
    expect(renderer!.root.findByType("fieldset").props.disabled).toBe(false);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      await submit();
    });
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each(["cancel", "unmount"] as const)("ignores save completion after %s", async (exit) => {
    const save = deferredSave();
    onSubmit.mockReturnValue(save.promise);
    open(request("build"));
    let completion!: Promise<void>;
    act(() => {
      completion = submit();
    });

    act(() => {
      if (exit === "cancel") {
        renderer!.root
          .findAllByType("button")
          .find((button) => button.children.includes("Cancel"))!
          .props.onClick();
      } else {
        renderer!.unmount();
        renderer = null;
      }
    });
    onClose.mockClear();
    await act(async () => {
      save.resolve(AsyncResult.success(undefined));
      await completion;
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});
