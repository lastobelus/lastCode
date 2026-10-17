import { EnvironmentId, MessageId } from "@t3tools/contracts";
import { transform } from "oxc-transform-react";
import { act, createElement, type ComponentType } from "react";
import { c } from "react/compiler-runtime";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useAssetUrls } from "../assets/assetUrls";
import type { TimelineEntriesInput, TimelineEntriesProjection } from "../session-logic";
import type { ChatMessage } from "../types";
import { makeStreamingTimelineFixture } from "../test-fixtures";
import { useIncrementalTimelineEntries } from "./useIncrementalTimelineEntries";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("~/state/session", () => ({ usePreparedConnection: () => ({ _tag: "None" }) }));
vi.mock("~/state/filesystem", () => ({
  useFilesystemReadAccess: () => ({ canReadFiles: false, canReadThreadFiles: false }),
}));
vi.mock("~/state/assets", () => ({ assetEnvironment: { createUrls: () => null } }));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));

type Entries = TimelineEntriesProjection["entries"];
type ProbeProps = {
  threadKey: string;
  input: TimelineEntriesInput;
  observe: (entries: Entries) => void;
};

// Exercise the real asset hook's fresh URL array and ChatView's derived map,
// including the compiler-enabled path that coverage-only compilation missed.
const probeSource = `function TimelineProbe({ threadKey, input, observe }) {
  const urls = useAssetUrls(environmentId, []);
  const attachmentUrlById = new Map([
    ...(input.attachmentUrlById ?? []),
    ...urls.flatMap((url, index) => url ? [[String(index), url]] : []),
  ]);
  const entries = useIncrementalTimelineEntries(threadKey, {
    ...input,
    visibleTurnItems: [...input.visibleTurnItems],
    optimisticMessages: [...input.optimisticMessages],
    anchoredMessages: [...(input.anchoredMessages ?? [])],
    attachmentUrlById,
  });
  observe(entries);
  return entries.length;
}`;

async function makeProbe(compiled: boolean): Promise<ComponentType<ProbeProps>> {
  const result = await transform("TimelineProbe.tsx", probeSource, {
    reactCompiler: compiled ? { reportDiagnostics: true } : false,
  });
  expect(result.errors).toEqual([]);
  const code = result.code.replace(
    /^const \{ c: _c \} = require\("react\/compiler-runtime"\);\n/m,
    "",
  );
  return new Function(
    "useAssetUrls",
    "useIncrementalTimelineEntries",
    "environmentId",
    "_c",
    `${code}\nreturn TimelineProbe;`,
  )(useAssetUrls, useIncrementalTimelineEntries, EnvironmentId.make("timeline-environment"), c);
}

let renderer: ReactTestRenderer | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

const message: ChatMessage = {
  id: MessageId.make("draft-message"),
  role: "user",
  text: "Keep this draft",
  createdAt: "2026-01-01T00:00:00.000Z",
  streaming: false,
  runId: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe.each([false, true])("incremental timeline (compiled=%s)", (compiled) => {
  it("mounts and updates a draft with fresh equivalent asset and timeline collections", async () => {
    const Probe = await makeProbe(compiled);
    let entries: Entries = [];
    const observe = (next: Entries) => {
      entries = next;
    };
    const input: TimelineEntriesInput = { visibleTurnItems: [], optimisticMessages: [] };
    await act(() => {
      renderer = create(createElement(Probe, { threadKey: "draft-one", input, observe }));
    });
    expect(renderer!.toJSON()).toBe("0");
    await act(() =>
      renderer!.update(
        createElement(Probe, {
          threadKey: "draft-one",
          input: { ...input, optimisticMessages: [message] },
          observe,
        }),
      ),
    );
    expect(renderer!.toJSON()).toBe("1");
    expect(entries[0]).toMatchObject({ kind: "message", message: { text: "Keep this draft" } });
    const previous = entries[0];
    await act(() =>
      renderer!.update(
        createElement(Probe, {
          threadKey: "draft-one",
          input: { ...input, optimisticMessages: [message] },
          observe,
        }),
      ),
    );
    expect(entries[0]).toBe(previous);
    await act(() =>
      renderer!.update(
        createElement(Probe, {
          threadKey: "draft-two",
          input,
          observe,
        }),
      ),
    );
    expect(renderer!.toJSON()).toBe("0");
  });
  it("refreshes attachment URLs without losing unchanged committed rows", async () => {
    const Probe = await makeProbe(compiled);
    const fixture = makeStreamingTimelineFixture();
    const visibleTurnItems = fixture.visibleTurnItems.slice(0, 1).map((row) => ({
      ...row,
      item:
        row.item.type === "user_message"
          ? {
              ...row.item,
              attachments: [
                {
                  type: "image" as const,
                  id: "image",
                  name: "image.png",
                  mimeType: "image/png",
                  sizeBytes: 12,
                },
              ],
            }
          : row.item,
    }));
    let entries: Entries = [];
    const observe = (next: Entries) => {
      entries = next;
    };
    const input: TimelineEntriesInput = {
      visibleTurnItems,
      optimisticMessages: [],
      attachmentUrlById: new Map([["image", "https://assets.example/first"]]),
    };
    await act(() => {
      renderer = create(createElement(Probe, { threadKey: "server-one", input, observe }));
    });
    const original = entries[0];
    expect(original).toMatchObject({
      message: { attachments: [{ previewUrl: "https://assets.example/first" }] },
    });
    await act(() =>
      renderer!.update(
        createElement(Probe, {
          threadKey: "server-one",
          input: {
            ...input,
            attachmentUrlById: new Map(input.attachmentUrlById),
          },
          observe,
        }),
      ),
    );
    expect(entries[0]).toBe(original);
    await act(() =>
      renderer!.update(
        createElement(Probe, {
          threadKey: "server-one",
          input: {
            ...input,
            attachmentUrlById: new Map([["image", "https://assets.example/renewed"]]),
          },
          observe,
        }),
      ),
    );
    expect(entries[0]).toMatchObject({
      message: { attachments: [{ previewUrl: "https://assets.example/renewed" }] },
    });
    expect(original).toMatchObject({
      message: { attachments: [{ previewUrl: "https://assets.example/first" }] },
    });
  });
});
