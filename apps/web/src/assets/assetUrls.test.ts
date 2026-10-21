import {
  AuthOrchestrationReadScope,
  EnvironmentId,
  ThreadId,
  type AuthSessionState,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, expect, it, vi } from "vite-plus/test";

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

const environmentId = EnvironmentId.make("asset-environment");
const threadId = ThreadId.make("asset-thread");
const resource = { _tag: "media-file", threadId, path: "/repo/image.png" } as const;

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
    expect(useAssetUrlState(environmentId, { ...resource, _tag })).toMatchObject({
      _tag: "Success",
    });
    expect(state.assetQuery).toHaveBeenCalledWith({
      environmentId,
      input: { resource: { ...resource, linkedThreadFile: true } },
    });
  },
);

it("keeps draft host files blocked when only published thread files are allowed", () => {
  state.session = { authenticated: true, permissions: [AuthOrchestrationReadScope] };
  expect(
    useAssetUrlState(environmentId, {
      _tag: "draft-workspace-file",
      cwd: "/repo",
      path: "image.png",
    }),
  ).toEqual({ _tag: "Failure", reason: "missing-file-access" });
  expect(state.assetQuery).not.toHaveBeenCalled();
});
