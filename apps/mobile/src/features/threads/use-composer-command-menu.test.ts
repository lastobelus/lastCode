import { describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type OrchestrationMessageContext,
} from "@t3tools/contracts";
import type { EnvironmentThreadMentionCandidate } from "@t3tools/client-runtime/state/thread-search";

const selection = vi.hoisted(() => ({
  candidates: [] as EnvironmentThreadMentionCandidate[],
  text: "",
  context: { version: 1, records: [] } as OrchestrationMessageContext,
}));
vi.mock("react", () => ({
  useEffect: () => {},
  useState: <A>(initial: A | (() => A)) => [
    typeof initial === "function" ? (initial as () => A)() : initial,
    vi.fn(),
  ],
}));
vi.mock("@effect/atom-react", () => ({ useAtomRefresh: () => () => {} }));

vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: ["local", "remote"].map((environmentId) => ({
      environmentId,
      label: environmentId,
      entry: { enabled: true },
      connection: { phase: "connected" },
      serverConfig: { environment: { capabilities: { universalThreadReferences: true } } },
    })),
  }),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentsWithScope: () => new Set(["local", "remote"]),
}));

vi.mock("../../state/queries", () => ({
  useComposerPathSearch: () => ({ entries: [], isPending: false }),
  useComposerPullRequestSearch: () => ({ entries: [], isPending: false, error: null }),
  useThreadSearch: () => ({ mentionCandidates: selection.candidates, isPending: false }),
}));
vi.mock("../../state/use-composer-drafts", () => ({
  getComposerDraftSnapshot: () => ({ context: selection.context }),
  setComposerDraftContext: (_key: string, context: OrchestrationMessageContext) => {
    selection.context = context;
  },
  useComposerDraftSelection: () => null,
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "context-id" }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providersValueAtom: vi.fn(),
    refreshProviders: Symbol("refreshProviders"),
  },
}));

import {
  buildComposerSlashCommandItems,
  resolveComposerCommandSelection,
  resolveComposerMenuSelection,
  useComposerCommandMenu,
} from "./use-composer-command-menu";

it("selects an archived search-only thread into the draft without a cached shell", () => {
  selection.text = "Look @arch";
  selection.context = { version: 1, records: [] };
  selection.candidates = [
    {
      environmentId: EnvironmentId.make("remote"),
      id: ThreadId.make("archived"),
      projectId: ProjectId.make("project"),
      projectTitle: "Project",
      title: "Archived conversation",
      branch: null,
      opens: null,
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
      latestUserMessageAt: null,
      archivedAt: "2026-10-02T00:00:00Z",
      lineage: {
        rootThreadId: ThreadId.make("archived"),
        parentThreadId: null,
        relationshipToParent: null,
      },
    },
  ];
  const menu = useComposerCommandMenu({
    draftMessage: selection.text,
    ownerKey: "draft",
    environmentId: EnvironmentId.make("local"),
    threadShells: [],
    projectCwd: null,
    selectedProviderStatus: null,
    hasThread: true,
    hasCompactableConversation: false,
    onChangeDraftMessage: (text) => {
      selection.text = text;
    },
  });
  const item = menu.items.find((candidate) => candidate.type === "thread");
  expect(item).toBeDefined();
  if (!item) throw new Error("Expected the search-only candidate");
  menu.onSelect(item);
  expect(selection.context.records).toMatchObject([
    {
      kind: "thread",
      environmentId: "remote",
      threadId: "archived",
      title: "Archived conversation",
    },
  ]);
  expect(selection.text).toContain("t3-context://v1/thread/");
  expect(selection.text).not.toContain("@arch");
});

describe("resolveComposerMenuSelection", () => {
  it("prefers the caret an insertion placed in the current draft text", () => {
    expect(
      resolveComposerMenuSelection({
        draftMessage: "hello @chip ",
        ownerKey: "draft-a",
        inserted: { start: 12, end: 12 },
        local: { ownerKey: "draft-a", start: 2, end: 2 },
      }),
    ).toEqual({ start: 12, end: 12 });
  });

  it("clamps the composer's own caret when the draft shrinks", () => {
    expect(
      resolveComposerMenuSelection({
        draftMessage: "hi",
        ownerKey: "draft-a",
        inserted: null,
        local: { ownerKey: "draft-a", start: 5, end: 9 },
      }),
    ).toEqual({ start: 2, end: 2 });
  });

  it("starts at the end of the draft after switching owners", () => {
    expect(
      resolveComposerMenuSelection({
        draftMessage: "other draft",
        ownerKey: "draft-b",
        inserted: null,
        local: { ownerKey: "draft-a", start: 1, end: 1 },
      }),
    ).toEqual({ start: 11, end: 11 });
  });
});

describe("mobile slash commands", () => {
  const antigravity = {
    driver: ProviderDriverKind.make("antigravity"),
    showInteractionModeToggle: false,
    slashCommands: [{ name: "plan", description: "Plan with Antigravity" }],
  };

  it.each([false, true])(
    "keeps native /plan with legacy mode enabled=%s",
    (allowInteractionMode) => {
      const items = buildComposerSlashCommandItems({
        query: "pl",
        atMessageStart: true,
        hasThread: true,
        allowInteractionMode,
        selectedProviderStatus: antigravity,
      });

      expect(items).toHaveLength(1);
      expect(items[0]?.type).toBe("provider-slash-command");
      const item = items[0];
      if (!item) throw new Error("Expected the native plan command");
      expect(
        resolveComposerCommandSelection({
          draftMessage: "/pl",
          trigger: { rangeStart: 0, rangeEnd: 3 },
          item,
          allowInteractionMode,
        }),
      ).toEqual({ text: "/plan ", cursor: 6, interactionMode: null });
    },
  );

  it("still applies the T3 plan command for supported providers", () => {
    const items = buildComposerSlashCommandItems({
      query: "plan",
      atMessageStart: true,
      hasThread: true,
      allowInteractionMode: true,
      selectedProviderStatus: {
        driver: ProviderDriverKind.make("codex"),
        slashCommands: [],
      },
    });
    const item = items[0];
    if (!item) throw new Error("Expected the T3 plan command");
    expect(
      resolveComposerCommandSelection({
        draftMessage: "/plan",
        trigger: { rangeStart: 0, rangeEnd: 5 },
        item,
        allowInteractionMode: true,
      }),
    ).toEqual({ text: "", cursor: 0, interactionMode: "plan" });

    expect(
      resolveComposerCommandSelection({
        draftMessage: "/plan",
        trigger: { rangeStart: 0, rangeEnd: 5 },
        item,
        allowInteractionMode: false,
      }),
    ).toEqual({ text: "/plan ", cursor: 6, interactionMode: null });
  });
});
