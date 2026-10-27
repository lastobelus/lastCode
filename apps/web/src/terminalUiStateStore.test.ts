import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ProjectScript } from "@t3tools/contracts";
import {
  EMPTY_TERMINAL_SESSION_STATE,
  type KnownTerminalSession,
} from "@t3tools/client-runtime/state/terminal";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  migratePersistedTerminalUiStateStoreState,
  selectThreadTerminalUiState,
  useTerminalUiStateStore,
} from "./terminalUiStateStore";
import { selectProjectScriptTerminal } from "./projectScripts";

const THREAD_ID = ThreadId.make("thread-1");
const THREAD_REF = scopeThreadRef(EnvironmentId.make("environment-a"), THREAD_ID);
const OTHER_THREAD_REF = scopeThreadRef(EnvironmentId.make("environment-b"), THREAD_ID);

const ORDINARY_ACTION = {
  id: "check",
  name: "Check",
  command: "echo ready",
  icon: "test",
  runOnWorktreeCreate: false,
} satisfies ProjectScript;

function selectOrdinaryActionTerminal(
  threadRef = THREAD_REF,
  sessions: ReadonlyArray<KnownTerminalSession> = [],
) {
  const store = useTerminalUiStateStore.getState();
  const ui = selectThreadTerminalUiState(store.terminalUiStateByThreadKey, threadRef);
  return selectProjectScriptTerminal({
    script: ORDINARY_ACTION,
    baseTerminalId: ui.activeTerminalId,
    existingTerminalIds: ui.terminalIds,
    pendingTerminalLinkProfiles:
      store.pendingTerminalLinkProfilesByThreadKey[scopedThreadKey(threadRef)],
    baseTerminalLinkProfileName: sessions.find(
      (session) => session.target.terminalId === ui.activeTerminalId,
    )?.state.terminalLinkProfileName,
    isBaseTerminalBusy: false,
    preferNewTerminal: false,
    canReuseTerminal: true,
    canReadTerminal: true,
    allocateTerminalId: () => "ordinary-terminal",
  });
}

function knownSession(threadRef = THREAD_REF, terminalId = "named-terminal", profileName?: string) {
  return {
    target: { ...threadRef, terminalId },
    state: {
      ...EMPTY_TERMINAL_SESSION_STATE,
      ...(profileName === undefined ? {} : { terminalLinkProfileName: profileName }),
    },
  };
}

describe("terminalUiStateStore actions", () => {
  beforeEach(() => {
    useTerminalUiStateStore.persist.clearStorage();
    useTerminalUiStateStore.setState({
      terminalUiStateByThreadKey: {},
      suppressedTerminalIdsByThreadKey: {},
      pendingTerminalLinkProfilesByThreadKey: {},
    });
  });

  it("caps splits at four terminals per group", () => {
    const store = useTerminalUiStateStore.getState();
    store.splitTerminal(THREAD_REF, "terminal-2");
    store.splitTerminal(THREAD_REF, "terminal-3");
    store.splitTerminal(THREAD_REF, "terminal-4");
    store.splitTerminal(THREAD_REF, "terminal-5");
    store.splitTerminal(THREAD_REF, "terminal-6");

    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState.terminalIds).toEqual([
      "terminal-2",
      "terminal-3",
      "terminal-4",
      "terminal-5",
    ]);
    expect(terminalUiState.terminalGroups).toEqual([
      {
        id: "group-terminal-2",
        terminalIds: ["terminal-2", "terminal-3", "terminal-4", "terminal-5"],
      },
    ]);
  });

  it("keeps an immediate ordinary Action out of a named Action before metadata arrives", () => {
    const store = useTerminalUiStateStore.getState();
    store.newTerminal(THREAD_REF, "idle-terminal");
    const named = selectProjectScriptTerminal({
      script: { ...ORDINARY_ACTION, terminalLinkProfileName: "Work account" },
      baseTerminalId: "idle-terminal",
      existingTerminalIds: ["idle-terminal"],
      isBaseTerminalBusy: false,
      preferNewTerminal: false,
      canReuseTerminal: true,
      canReadTerminal: true,
      allocateTerminalId: () => "unused",
    });
    store.newTerminal(THREAD_REF, named.terminalId, named.terminalLinkProfileName);

    // No server metadata or running-process update has been delivered.
    const ordinary = selectOrdinaryActionTerminal();
    expect(ordinary).toEqual({ createNewTerminal: true, terminalId: "ordinary-terminal" });
    expect(ordinary.terminalId).not.toBe(named.terminalId);
  });

  it("hands profile protection to matching metadata without removing the live terminal", () => {
    const store = useTerminalUiStateStore.getState();
    store.newTerminal(THREAD_REF, "named-terminal", "Work account");
    store.confirmPendingTerminalLinkProfiles(THREAD_REF, []);
    store.confirmPendingTerminalLinkProfiles(THREAD_REF, [knownSession()]);
    store.confirmPendingTerminalLinkProfiles(THREAD_REF, [
      knownSession(THREAD_REF, "named-terminal", "Other account"),
    ]);
    expect(selectOrdinaryActionTerminal().createNewTerminal).toBe(true);

    const sessions = [knownSession(THREAD_REF, "named-terminal", "Work account")];
    const before = useTerminalUiStateStore.getState().terminalUiStateByThreadKey;
    store.confirmPendingTerminalLinkProfiles(THREAD_REF, sessions);
    expect(useTerminalUiStateStore.getState().pendingTerminalLinkProfilesByThreadKey).toEqual({});
    expect(useTerminalUiStateStore.getState().terminalUiStateByThreadKey).toBe(before);
    expect(selectOrdinaryActionTerminal(THREAD_REF, sessions).createNewTerminal).toBe(true);
  });

  it("releases a failed allocation without clearing another pending Action or terminal UI", () => {
    const store = useTerminalUiStateStore.getState();
    store.newTerminal(THREAD_REF, "live-terminal", "Work account");
    store.newTerminal(THREAD_REF, "failed-terminal", "Other account");
    const before = useTerminalUiStateStore.getState().terminalUiStateByThreadKey;
    store.releasePendingTerminalLinkProfile(THREAD_REF, "failed-terminal");
    expect(useTerminalUiStateStore.getState().terminalUiStateByThreadKey).toBe(before);
    expect(useTerminalUiStateStore.getState().pendingTerminalLinkProfilesByThreadKey).toEqual({
      [scopedThreadKey(THREAD_REF)]: { "live-terminal": "Work account" },
    });
    expect(selectOrdinaryActionTerminal()).toEqual({
      createNewTerminal: false,
      terminalId: "failed-terminal",
    });
    store.setActiveTerminal(THREAD_REF, "live-terminal");
    expect(selectOrdinaryActionTerminal().createNewTerminal).toBe(true);
  });

  it("keeps pending intent and confirmation isolated by thread and environment", () => {
    const store = useTerminalUiStateStore.getState();
    const otherThread = scopeThreadRef(THREAD_REF.environmentId, ThreadId.make("thread-2"));
    store.newTerminal(THREAD_REF, "named-terminal", "Work account");
    store.newTerminal(OTHER_THREAD_REF, "named-terminal");
    store.newTerminal(otherThread, "named-terminal");
    store.confirmPendingTerminalLinkProfiles(THREAD_REF, [
      knownSession(OTHER_THREAD_REF, "named-terminal", "Work account"),
      knownSession(otherThread, "named-terminal", "Work account"),
    ]);
    expect(selectOrdinaryActionTerminal().createNewTerminal).toBe(true);
    expect(selectOrdinaryActionTerminal(OTHER_THREAD_REF).createNewTerminal).toBe(false);
    expect(selectOrdinaryActionTerminal(otherThread).createNewTerminal).toBe(false);
    store.releasePendingTerminalLinkProfile(OTHER_THREAD_REF, "named-terminal");
    expect(selectOrdinaryActionTerminal().createNewTerminal).toBe(true);
  });

  it("keeps unconfirmed allocations through partial metadata reconciliation", () => {
    const store = useTerminalUiStateStore.getState();
    store.newTerminal(THREAD_REF, "named-terminal", "Work account");
    store.reconcileTerminalIds(THREAD_REF, ["other-terminal"]);
    const ui = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(ui.terminalIds).toEqual(["other-terminal", "named-terminal"]);
    expect(selectOrdinaryActionTerminal().createNewTerminal).toBe(true);
  });

  it("still reuses an idle ordinary terminal with no pending profile", () => {
    useTerminalUiStateStore.getState().newTerminal(THREAD_REF, "idle-terminal");
    expect(selectOrdinaryActionTerminal()).toEqual({
      createNewTerminal: false,
      terminalId: "idle-terminal",
    });
  });

  it.each(["close", "clear", "remove", "orphan"])(
    "drops pending intent on explicit %s cleanup",
    (cleanup) => {
      const store = useTerminalUiStateStore.getState();
      store.newTerminal(THREAD_REF, "named-terminal", "Work account");
      store.newTerminal(OTHER_THREAD_REF, "other-terminal", "Other account");
      if (cleanup === "close") store.closeTerminal(THREAD_REF, "named-terminal");
      if (cleanup === "clear") store.clearTerminalUiState(THREAD_REF);
      if (cleanup === "remove") store.removeTerminalUiState(THREAD_REF);
      if (cleanup === "orphan")
        store.removeOrphanedTerminalUiStates(new Set([scopedThreadKey(OTHER_THREAD_REF)]));
      expect(useTerminalUiStateStore.getState().pendingTerminalLinkProfilesByThreadKey).toEqual({
        [scopedThreadKey(OTHER_THREAD_REF)]: { "other-terminal": "Other account" },
      });
    },
  );
  it("keeps state isolated per environment when raw thread ids collide", () => {
    const store = useTerminalUiStateStore.getState();
    store.setTerminalOpen(THREAD_REF, true);
    store.newTerminal(OTHER_THREAD_REF, "env-b-terminal");

    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).terminalOpen,
    ).toBe(true);
    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        OTHER_THREAD_REF,
      ).terminalIds,
    ).toEqual(["env-b-terminal"]);
  });

  it("drops persisted entries whose thread keys are not valid scoped keys", () => {
    const migrated = migratePersistedTerminalUiStateStoreState(
      {
        terminalStateByThreadKey: {
          [scopedThreadKey(THREAD_REF)]: {
            terminalOpen: true,
            terminalHeight: 320,
            terminalIds: ["term-1"],
            activeTerminalId: "term-1",
            terminalGroups: [{ id: "group-term-1", terminalIds: ["term-1"] }],
            activeTerminalGroupId: "group-term-1",
          },
          "legacy-thread-id": {
            terminalOpen: true,
            terminalHeight: 320,
            terminalIds: ["term-1"],
            activeTerminalId: "term-1",
            terminalGroups: [{ id: "group-term-1", terminalIds: ["term-1"] }],
            activeTerminalGroupId: "group-term-1",
          },
        },
      },
      2,
    );

    expect(migrated).toEqual({
      terminalUiStateByThreadKey: {
        [scopedThreadKey(THREAD_REF)]: {
          terminalOpen: true,
          terminalHeight: 320,
          terminalIds: ["term-1"],
          activeTerminalId: "term-1",
          terminalGroups: [{ id: "group-term-1", terminalIds: ["term-1"] }],
          activeTerminalGroupId: "group-term-1",
        },
      },
    });
  });

  it("resets to default and clears persisted entry when closing the last terminal", () => {
    const store = useTerminalUiStateStore.getState();
    store.newTerminal(THREAD_REF, "terminal-only");
    store.closeTerminal(THREAD_REF, "terminal-only");

    expect(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey[scopedThreadKey(THREAD_REF)],
    ).toBeUndefined();
    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).terminalIds,
    ).toEqual([]);
  });

  it("keeps a valid active terminal after closing an active split terminal", () => {
    const store = useTerminalUiStateStore.getState();
    store.splitTerminal(THREAD_REF, "terminal-2");
    store.splitTerminal(THREAD_REF, "terminal-3");
    store.closeTerminal(THREAD_REF, "terminal-3");

    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState.activeTerminalId).toBe("terminal-2");
    expect(terminalUiState.terminalIds).toEqual(["terminal-2"]);
    expect(terminalUiState.terminalGroups).toEqual([
      { id: "group-terminal-2", terminalIds: ["terminal-2"] },
    ]);
  });

  it("does not import a closed panel terminal from stale metadata", () => {
    const store = useTerminalUiStateStore.getState();
    store.newTerminal(THREAD_REF, "term-2");
    store.closeTerminal(THREAD_REF, "term-1");

    store.reconcileTerminalIds(THREAD_REF, ["term-1", "term-2"]);

    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).terminalIds,
    ).toEqual(["term-2"]);

    store.newTerminal(THREAD_REF, "term-1");
    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).terminalIds,
    ).toEqual(["term-2", "term-1"]);
  });
});
