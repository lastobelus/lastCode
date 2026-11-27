import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type LinkedArchivePreview,
  type OrchestrationV2ThreadArchiveFamily,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import {
  ArchiveFamilyToolResult,
  ArchiveToolSelectionInput,
} from "./LastCodeLinkedArchiveToolSchemas.ts";
import { archiveFamilyToolResult } from "./LastCodeLinkedArchiveTools.ts";

const root = ThreadId.make("archive-root");
const child = ThreadId.make("default-child");
const typed = ThreadId.make("typed-in-child");
const environmentId = EnvironmentId.make("build-machine");
const offline = EnvironmentId.make("offline-machine");
const archivedAt = "2026-11-18T20:00:00.000Z";
const defaultCohort = {
  anchorThreadId: child,
  selectedThreadIds: [child],
  typedIn: [],
  childDisposition: "stop_and_archive",
} as const;
const readyPeer = {
  environmentId,
  label: "Build machine",
  status: "ready",
  inventory: {
    environmentId,
    threads: [child, typed].map((threadId) => ({
      threadId,
      projectId: ProjectId.make("build-project"),
      title: threadId,
    })),
    typedInThreadIds: [typed],
    activeThreadIds: [child],
    unreadThreadIds: [],
    protectedThreadIds: [],
    keptThreadIds: [typed],
    archiveChoices: {
      defaultCohorts: [defaultCohort],
      includingTypedInCohorts: [
        defaultCohort,
        {
          anchorThreadId: typed,
          selectedThreadIds: [typed],
          typedIn: [{ threadId: typed, latestHumanMessageAt: archivedAt }],
          childDisposition: "archive_if_idle",
        },
      ],
    },
  },
} as const satisfies LinkedArchivePreview;
const pendingPeer = {
  environmentId: offline,
  label: "Offline machine",
  status: "pending",
  reason: "offline",
} as const satisfies LinkedArchivePreview;
const family: OrchestrationV2ThreadArchiveFamily = {
  threads: [],
  childThreadIds: [],
  activeChildThreadIds: [],
  activeThreadIds: [],
  unreadThreadIds: [],
  promotableChildThreadIds: [],
  keptThreadIds: [],
  protectedChildThreadIds: [],
  nativeStopCount: 0,
  requiresConfirmation: false,
  canPromote: false,
  canStopAndArchive: true,
  linkedArchivePreview: [readyPeer, pendingPeer],
};
const readySelection = {
  environmentId,
  label: readyPeer.label,
  status: "ready",
  cohorts: [{ ...defaultCohort, childDisposition: "archive_if_idle" }],
};
const familyCodec = Schema.toCodecJson(ArchiveFamilyToolResult);
const roundTripResult = (value: typeof ArchiveFamilyToolResult.Type) =>
  Schema.decodeSync(familyCodec)(Schema.encodeSync(familyCodec)(value));
const decodeSelection = Schema.decodeUnknownSync(Schema.toCodecJson(ArchiveToolSelectionInput));

it("returns copyable choices that cannot stop linked work and rejects malformed cohorts", () => {
  const preview = roundTripResult(archiveFamilyToolResult(root, family));
  expect(decodeSelection(preview.linkedArchiveSelection)).toEqual([readySelection, pendingPeer]);
  expect(preview.linkedArchivePreview?.[0]).toEqual(readyPeer);
  expect(() =>
    decodeSelection([
      { ...readySelection, cohorts: [{ ...defaultCohort, selectedThreadIds: [] }] },
    ]),
  ).toThrow();
});

it("returns exact retry arguments for the current archive and an older pending restore", () => {
  const archiveId = CommandId.make("current-archive");
  const restoreId = CommandId.make("earlier-archive");
  const preview = roundTripResult(
    archiveFamilyToolResult(root, {
      ...family,
      linkedArchiveOperations: [
        {
          sourceArchiveCommandId: archiveId,
          archivedAt,
          operation: "archive",
          machines: [
            { environmentId, label: readyPeer.label, status: "review", requiresReview: true },
            pendingPeer,
          ],
        },
        {
          sourceArchiveCommandId: restoreId,
          archivedAt,
          operation: "restore",
          machines: [pendingPeer],
        },
      ],
    }),
  );
  expect(preview.linkedArchiveSelection).toBeUndefined();
  expect(preview.linkedArchiveOperations?.map(({ retryArgs }) => retryArgs)).toEqual([
    {
      threadId: root,
      action: "archive",
      expectedLinkedArchiveCommandId: archiveId,
      linkedArchiveSelection: [readySelection],
    },
    {
      threadId: root,
      action: "unarchive",
      expectedLinkedArchiveCommandId: restoreId,
    },
  ]);

  const savedStop = roundTripResult(
    archiveFamilyToolResult(root, {
      ...family,
      linkedArchiveOperations: [
        {
          sourceArchiveCommandId: archiveId,
          archivedAt,
          operation: "archive",
          machines: [pendingPeer],
          retryMayStopWork: true,
        },
      ],
    }),
  ).linkedArchiveOperations?.[0];
  expect(savedStop?.retryArgs).toBeUndefined();
  expect(savedStop?.retryArgsAfterStopConsent).toEqual({
    threadId: root,
    action: "archive",
    expectedLinkedArchiveCommandId: archiveId,
    childDisposition: "stop_and_archive",
    linkedArchiveSelection: [],
  });
});
