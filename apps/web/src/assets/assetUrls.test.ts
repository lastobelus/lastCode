import { EnvironmentId, ThreadId, type AssetResource } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { makeRevisionedAssetUrlFamily } from "./assetUrls";

const environmentId = EnvironmentId.make("environment-1");
const resource: AssetResource = {
  _tag: "workspace-file",
  threadId: ThreadId.make("thread-1"),
  path: "docs/diagram.png",
};

type MintResult = AsyncResult.AsyncResult<{ relativeUrl: string; expiresAt: number }>;

const minted = (n: number): MintResult =>
  AsyncResult.success({ relativeUrl: `/a/${n}`, expiresAt: 0 });

// A stand-in for the asset URL query: a refresh starts a mint (counted, shown as
// waiting) and `settle` completes the latest one.
function setup(initial: MintResult) {
  let mints = 0;
  // Node removal runs on the registry's scheduler; `unmount` flushes it so the
  // next mount of the same revision builds a fresh node.
  const scheduled: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      scheduled.push(task);
      return () => {};
    },
  });
  const server = Atom.make(initial).pipe(Atom.keepAlive);
  const query = Atom.readable(
    (get) => get(server),
    () => {
      mints += 1;
      registry.set(server, AsyncResult.waiting(registry.get(server)));
    },
  ).pipe(Atom.keepAlive);
  const revisioned = makeRevisionedAssetUrlFamily(() => query);
  const mount = (revision: string | null) => {
    const release = registry.mount(revisioned({ environmentId, input: { resource }, revision }));
    return () => {
      release();
      for (const task of scheduled.splice(0)) task();
    };
  };
  const settle = () => registry.set(server, minted(mints + 1));
  return { mount, settle, mints: () => mints };
}

describe("makeRevisionedAssetUrlFamily", () => {
  it("re-mints a settled URL on first read and on each new revision, not on remount", () => {
    const { mount, settle, mints } = setup(minted(0));

    mount("mutation-1")();
    expect(mints()).toBe(1);
    settle();

    mount("mutation-1")();
    expect(mints()).toBe(1);

    mount("mutation-2")();
    expect(mints()).toBe(2);
  });

  it("re-mints when a revert returns to an earlier revision", () => {
    const { mount, settle, mints } = setup(minted(0));

    mount("mutation-a")();
    settle();
    mount("mutation-b")();
    settle();
    expect(mints()).toBe(2);

    const reverted = mount("mutation-a");
    expect(mints()).toBe(3);
    reverted();
  });

  it("shares a mint in flight on the first read", () => {
    const { mount, mints } = setup(AsyncResult.initial(true));

    mount("mutation-1")();
    expect(mints()).toBe(0);
  });

  it("re-mints after a mint that was in flight when the revision changed", () => {
    const { mount, settle, mints } = setup(minted(0));

    const before = mount("mutation-1");
    settle();
    const edited = mount("mutation-2");
    expect(mints()).toBe(2);
    before();

    const stillMinting = mount("mutation-3");
    edited();
    expect(mints()).toBe(2);

    settle();
    expect(mints()).toBe(3);
    settle();
    expect(mints()).toBe(3);
    stillMinting();
  });
});

import { AuthOrchestrationReadScope, type AuthSessionState } from "@t3tools/contracts";
import { beforeEach, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  session: null as Pick<AuthSessionState, "authenticated" | "scopes" | "permissions"> | null,
  phase: "connected" as "connected" | "offline",
  assetAtom: {},
  mint: vi.fn(),
  assetQuery: vi.fn(),
}));

vi.mock("react", () => ({ useCallback: <A>(callback: A) => callback }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === state.assetAtom
      ? AsyncResult.success({ relativeUrl: "/api/assets/image.png", expiresAt: 1 })
      : AsyncResult.initial(false),
}));
vi.mock("~/state/session", () => ({
  usePreparedConnection: () => ({ _tag: "Some", value: { httpBaseUrl: "https://host.test" } }),
}));
vi.mock("~/state/filesystem", async () => {
  const { resolveFilesystemReadAccess } = await import("@t3tools/client-runtime/state/filesystem");
  return {
    useFilesystemReadAccess: () => ({
      ...resolveFilesystemReadAccess({
        isCatalogReady: true,
        connection: { phase: state.phase, error: null },
        session: state.session,
        sessionError: null,
      }),
      canReadThreadFiles:
        state.session?.authenticated === true &&
        state.session.permissions?.includes("orchestration:read") === true,
    }),
  };
});
vi.mock("~/state/assets", () => ({
  assetEnvironment: { createUrl: state.assetQuery },
}));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => state.mint }));

import { useAssetUrlState } from "./assetUrls";

const restrictedEnvironmentId = EnvironmentId.make("asset-environment");
const threadId = ThreadId.make("asset-thread");
const restrictedResource = { _tag: "media-file", threadId, path: "/repo/image.png" } as const;

beforeEach(() => {
  state.session = null;
  state.phase = "connected";
  state.assetQuery.mockReset().mockReturnValue(state.assetAtom);
  state.mint
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ relativeUrl: "/api/assets/image.png", expiresAt: 1 }));
});

it.each(["workspace-file", "media-file"] as const)(
  "requests only the linked file capability for restricted %s previews",
  (_tag) => {
    state.session = { authenticated: true, permissions: [AuthOrchestrationReadScope] };
    expect(
      useAssetUrlState(restrictedEnvironmentId, { ...restrictedResource, _tag }),
    ).toMatchObject({
      _tag: "Success",
    });
    expect(state.assetQuery).toHaveBeenCalledWith({
      environmentId: restrictedEnvironmentId,
      input: { resource: { ...restrictedResource, linkedThreadFile: true } },
    });
  },
);

it("keeps draft host files blocked when only published thread files are allowed", () => {
  state.session = { authenticated: true, permissions: [AuthOrchestrationReadScope] };
  expect(
    useAssetUrlState(restrictedEnvironmentId, {
      _tag: "draft-workspace-file",
      cwd: "/repo",
      path: "image.png",
    }),
  ).toEqual({ _tag: "Failure", reason: "missing-file-access" });
  expect(state.assetQuery).not.toHaveBeenCalled();
});
