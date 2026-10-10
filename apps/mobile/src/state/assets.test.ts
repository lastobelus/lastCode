import {
  AuthFilesystemReadScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
  ThreadId,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  session: null as Pick<AuthSessionState, "authenticated" | "scopes" | "permissions"> | null,
  phase: "connected" as "connected" | "offline",
  assetAtom: {},
  assetError: null as Error | null,
  mint: vi.fn(),
  assetQuery: vi.fn(),
}));

vi.mock("react", () => ({ useCallback: <A>(callback: A) => callback }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === state.assetAtom
      ? state.assetError
        ? AsyncResult.failure(Cause.fail(state.assetError))
        : AsyncResult.success({ relativeUrl: "/api/assets/image.png", expiresAt: 1 })
      : AsyncResult.initial(false),
}));
vi.mock("./session", () => ({
  environmentSession: { sessionStateAtom: () => ({}) },
  usePreparedConnection: () => ({ _tag: "Some", value: { httpBaseUrl: "https://host.test" } }),
}));
vi.mock("./presentation", () => ({
  useEnvironmentPresentation: () => ({
    isReady: true,
    presentation: { connection: { phase: state.phase, error: null } },
  }),
}));
vi.mock("./query", () => ({
  useEnvironmentQuery: () => ({ data: state.session, error: null }),
}));
vi.mock("./projectClones", () => ({ environmentProjectCloneListAtom: () => null }));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/assets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/assets")>()),
  createAssetEnvironmentAtoms: () => ({ createUrl: state.assetQuery }),
}));
vi.mock("./use-atom-query-runner", () => ({ useAtomQueryRunner: () => state.mint }));

import { useRefreshAssetUrl, useAssetUrlState } from "./assets";

const environmentId = EnvironmentId.make("asset-environment");
const threadId = ThreadId.make("asset-thread");
const resource = { _tag: "media-file", threadId, path: "/repo/image.png" } as const;

beforeEach(() => {
  state.session = null;
  state.assetError = null;
  state.phase = "connected";
  state.assetQuery.mockReset().mockReturnValue(state.assetAtom);
  state.mint
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ relativeUrl: "/api/assets/image.png", expiresAt: 1 }));
});

it.each(["workspace-file", "media-file"] as const)(
  "keeps %s loading until its file grant resolves",
  (_tag) => {
    expect(useAssetUrlState(environmentId, { ...resource, _tag })).toEqual({ _tag: "Loading" });
    expect(state.assetQuery).not.toHaveBeenCalled();

    state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
    expect(useAssetUrlState(environmentId, { ...resource, _tag })).toEqual({
      _tag: "Success",
      expiresAt: 1,
      url: "https://host.test/api/assets/image.png",
    });
    expect(state.assetQuery).toHaveBeenCalledWith({
      environmentId,
      input: { resource: { ...resource, _tag } },
    });
  },
);

it("hides host assets with a denied grant while preserving attachments", () => {
  state.session = { authenticated: true, scopes: [] };
  expect(useAssetUrlState(environmentId, resource)).toEqual({ _tag: "Failure", reason: "failed" });
  expect(state.assetQuery).not.toHaveBeenCalled();
  expect(useAssetUrlState(environmentId, { _tag: "attachment", attachmentId: "upload" })).toEqual({
    _tag: "Success",
    expiresAt: 1,
    url: "https://host.test/api/assets/image.png",
  });
});

it("stops waiting for an unresolved grant when the connection is offline", () => {
  state.phase = "offline";
  expect(useAssetUrlState(environmentId, resource)).toEqual({
    _tag: "Failure",
    reason: "disconnected",
  });
  expect(state.assetQuery).not.toHaveBeenCalled();
});

it("lets the server authorize an explicit refresh before the client grant loads", async () => {
  await expect(useRefreshAssetUrl(environmentId, resource)()).resolves.toBe(
    "https://host.test/api/assets/image.png",
  );
  expect(state.mint).toHaveBeenCalledWith({
    environmentId,
    input: { resource: { ...resource, linkedThreadFile: true } },
  });

  const denied = new EnvironmentAuthorizationError({
    message: "This connection cannot read host files.",
    requiredScope: AuthFilesystemReadScope,
  });
  state.mint.mockResolvedValue(AsyncResult.failure(Cause.fail(denied)));
  await expect(useRefreshAssetUrl(environmentId, resource)()).resolves.toBeNull();
});

it.each(["workspace-file", "media-file"] as const)(
  "requests an exact linked file for %s with only thread read access",
  (_tag) => {
    state.session = {
      authenticated: true,
      scopes: [AuthOrchestrationReadScope],
      permissions: [AuthOrchestrationReadScope],
    };
    expect(useAssetUrlState(environmentId, { ...resource, _tag })._tag).toBe("Success");
    expect(state.assetQuery).toHaveBeenCalledWith({
      environmentId,
      input: { resource: { ...resource, linkedThreadFile: true } },
    });
  },
);

it("keeps general draft assets gated under thread read access", () => {
  state.session = {
    authenticated: true,
    scopes: [AuthOrchestrationReadScope],
    permissions: [AuthOrchestrationReadScope],
  };
  expect(
    useAssetUrlState(environmentId, {
      _tag: "draft-workspace-file",
      cwd: "/repo",
      path: "image.png",
    })._tag,
  ).toBe("Failure");
  expect(state.assetQuery).not.toHaveBeenCalled();
});

it("refreshes linked media through the scoped server check", async () => {
  state.session = {
    authenticated: true,
    scopes: [AuthOrchestrationReadScope],
    permissions: [AuthOrchestrationReadScope],
  };
  await useRefreshAssetUrl(environmentId, resource)();
  expect(state.mint).toHaveBeenCalledWith({
    environmentId,
    input: { resource: { ...resource, linkedThreadFile: true } },
  });
});

it("returns no URL when the server denies a scoped refresh", async () => {
  state.session = {
    authenticated: true,
    scopes: [AuthOrchestrationReadScope],
    permissions: [AuthOrchestrationReadScope],
  };
  state.mint.mockResolvedValue(
    AsyncResult.failure(
      Cause.fail(
        new EnvironmentAuthorizationError({
          message: "This file is not linked in this thread.",
          requiredScope: AuthFilesystemReadScope,
        }),
      ),
    ),
  );
  await expect(useRefreshAssetUrl(environmentId, resource)()).resolves.toBeNull();
  expect(state.mint).toHaveBeenCalledWith({
    environmentId,
    input: { resource: { ...resource, linkedThreadFile: true } },
  });
});

it("keeps a friendly preview failure when the server returns an internal error", () => {
  state.session = {
    authenticated: true,
    scopes: [AuthOrchestrationReadScope],
    permissions: [AuthOrchestrationReadScope],
  };
  state.assetError = new Error("Failed to resolve workspace.");
  expect(useAssetUrlState(environmentId, resource)).toEqual({ _tag: "Failure", reason: "failed" });
});
