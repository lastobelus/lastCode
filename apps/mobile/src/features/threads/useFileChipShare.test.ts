import {
  AuthFilesystemReadScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  sessionGrantsScope,
  ThreadId,
  type SessionGrantInput,
} from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  session: { authenticated: true, permissions: ["orchestration:read"] } as SessionGrantInput,
  httpBaseUrl: "https://environment.example",
  refs: [] as { current: unknown }[],
  refIndex: 0,
  mint: vi.fn(),
  download: vi.fn(),
  alert: vi.fn(),
}));

vi.mock("react", () => ({
  useCallback: <A>(callback: A) => callback,
  useEffect: () => {},
  useLayoutEffect: (effect: () => void) => effect(),
  useRef: <A>(initial: A) => {
    const index = state.refIndex++;
    state.refs[index] ??= { current: initial };
    return state.refs[index] as { current: A };
  },
}));
vi.mock("react-native", () => ({ Alert: { alert: state.alert } }));
vi.mock("../../state/assets", () => ({
  assetEnvironment: { createUrl: {} },
  useHostFileAccess: () => ({
    canReadFiles: sessionGrantsScope(state.session, AuthFilesystemReadScope),
  }),
}));
vi.mock("../../state/session", () => ({
  usePreparedConnection: () => ({ _tag: "Some", value: { httpBaseUrl: state.httpBaseUrl } }),
}));
vi.mock("../../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => state.mint }));
vi.mock("../../lib/attachmentDownload", () => ({ downloadAndShareAttachment: state.download }));

import { useFileChipShare } from "./useFileChipShare";

const environmentId = EnvironmentId.make("share-environment");
const threadId = ThreadId.make("share-thread");
const target = { fullPath: "/workspace/report%20#one.pdf" };
const resource = { _tag: "media-file", threadId, path: target.fullPath };

function renderShare() {
  state.refIndex = 0;
  return useFileChipShare(environmentId, threadId, "share-source");
}

beforeEach(() => {
  state.session = { authenticated: true, permissions: [AuthOrchestrationReadScope] };
  state.httpBaseUrl = "https://environment.example";
  state.refs = [];
  state.mint.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { relativeUrl: "/api/assets/fresh-report", expiresAt: 1 },
  });
  state.download.mockReset().mockResolvedValue(undefined);
  state.alert.mockReset();
});

it("shares a linked file with conversation access through an exact scoped request", async () => {
  await renderShare()(target);

  expect(state.mint).toHaveBeenCalledWith({
    environmentId,
    input: { resource: { ...resource, linkedThreadFile: true } },
  });
  expect(state.download).toHaveBeenCalledWith(
    expect.objectContaining({
      url: "https://environment.example/api/assets/fresh-report",
      attachment: expect.objectContaining({ name: "report%20#one.pdf", resource }),
      sourceIdentifier: "share-source",
    }),
  );
  expect(state.alert).not.toHaveBeenCalled();
});

it("preserves general file authorization for a full-file grant", async () => {
  state.session = { authenticated: true, permissions: [AuthFilesystemReadScope] };
  await renderShare()(target);

  expect(state.mint).toHaveBeenCalledWith({ environmentId, input: { resource } });
  expect(state.download).toHaveBeenCalledOnce();
});

it("uses current access and origin when a retained menu action is selected", async () => {
  state.session = { authenticated: true, permissions: [AuthFilesystemReadScope] };
  const share = renderShare();
  state.session = { authenticated: true, permissions: [AuthOrchestrationReadScope] };
  state.httpBaseUrl = "https://reconnected.example";
  renderShare();
  await share(target);

  expect(state.mint).toHaveBeenCalledWith({
    environmentId,
    input: { resource: { ...resource, linkedThreadFile: true } },
  });
  expect(state.download).toHaveBeenCalledWith(
    expect.objectContaining({
      url: "https://reconnected.example/api/assets/fresh-report",
    }),
  );
});

it("does not download when the server denies a scoped file request", async () => {
  state.mint.mockResolvedValue({ _tag: "Failure" });
  await renderShare()(target);

  expect(state.download).not.toHaveBeenCalled();
  expect(state.alert).toHaveBeenCalledWith(
    "Could not share file",
    "The file could not be loaded. Reconnect and try again.",
  );
});
