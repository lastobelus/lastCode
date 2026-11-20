import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import {
  DraftId,
  partializeComposerDraftStoreState,
  useComposerDraftStore,
} from "./composerDraftStore";
import { draftOriginForEnvironmentChange, temporaryDraftProjectRef } from "./draftTemporaryProject";

it("retains the origin after restoring a switched draft and clears it on an explicit project change", () => {
  const draftId = DraftId.make("temporary-origin");
  const origin = scopeProjectRef(EnvironmentId.make("a"), ProjectId.make("temporary"));
  const destination = scopeProjectRef(EnvironmentId.make("b"), ProjectId.make("ordinary"));
  const replacement = scopeProjectRef(EnvironmentId.make("b"), ProjectId.make("replacement"));
  const project: EnvironmentProject = {
    id: origin.projectId,
    environmentId: origin.environmentId,
    title: "Temporary",
    workspaceRoot: "/work/temporary",
    temporary: true,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  };
  const store = useComposerDraftStore.getState();
  store.clearDraftThread(draftId);
  store.setProjectDraftThreadId(origin, draftId);
  store.setPrompt(draftId, "Preserve this draft");
  store.setDraftThreadContext(draftId, {
    projectRef: destination,
    ...draftOriginForEnvironmentChange(store.getDraftSession(draftId), [project]),
  });

  const persisted = partializeComposerDraftStoreState(useComposerDraftStore.getState());
  const restored = useComposerDraftStore.persist.getOptions().merge!(
    JSON.parse(JSON.stringify(persisted)),
    useComposerDraftStore.getInitialState(),
  );
  expect(
    temporaryDraftProjectRef(restored.draftThreadsByThreadKey[draftId]?.temporaryProjectOriginKey),
  ).toEqual(origin);

  store.setProjectDraftThreadId(replacement, draftId);
  expect(store.getDraftSession(draftId)?.temporaryProjectOriginKey).toBeUndefined();
  store.clearDraftThread(draftId);
});
