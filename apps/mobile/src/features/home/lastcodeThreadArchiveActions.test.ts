import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { ThreadArchiveFamily } from "@t3tools/client-runtime/state/thread-archive";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { makeThreadShellFixture } from "../../test-fixtures";

const state = vi.hoisted(() => ({
  shells: [] as ReturnType<typeof makeThreadShellFixture>[],
  alerts: [] as { message: string; buttons: { text: string; onPress?: () => void }[] }[],
  sheets: [] as {
    confirm: (includeTypedIn: boolean) => {
      message: string;
      confirmLabel: string;
      blocked: boolean;
    };
    accept: (choice: { includeTypedIn: boolean }) => void;
  }[],
}));
vi.mock("../../state/threads", () => ({ environmentThreadShells: { threadShellsAtom: "shells" } }));
vi.mock("../../state/projects", () => ({ environmentProjects: { projectAtom: () => "project" } }));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: "configs" }));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    get: (key: string) =>
      key === "shells"
        ? state.shells
        : new Map(
            state.shells.map((shell) => [
              shell.environmentId,
              { environment: { capabilities: { threadArchiveFamiliesV2: true } } },
            ]),
          ),
  },
}));
vi.mock("../../components/ui/Dialog", () => ({
  alert: (_title: string, message: string, buttons = []) => state.alerts.push({ message, buttons }),
}));
vi.mock("../archive/lastCodeMobileArchiveDialogState", () => ({
  requestLastCodeMobileArchiveDialog: ({ confirm }: (typeof state.sheets)[number]) =>
    new Promise((accept) => state.sheets.push({ confirm, accept })),
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "fresh-action-id" }));
import { prepareLastCodeMobileThreadArchive } from "./lastcodeThreadArchiveActions";

function setup() {
  const owner = makeThreadShellFixture({
    environmentId: EnvironmentId.make("asked-environment"),
    id: ThreadId.make("owner"),
  });
  const child = makeThreadShellFixture({
    environmentId: owner.environmentId,
    id: ThreadId.make("child"),
    title: "Child work",
  });
  state.shells = [owner, child];
  state.alerts = [];
  state.sheets = [];
  const family: ThreadArchiveFamily = {
    threads: [owner, child],
    children: [child],
    childThreadIds: [child.id],
    activeThreadIds: [child.id],
    activeChildThreadIds: [child.id],
    unreadThreadIds: [],
    protectedChildThreadIds: [],
    activeChildren: [child],
    activeThreads: [child],
    unreadThreads: [],
    protectedChildren: [],
    promotableChildThreadIds: [],
    keptThreadIds: [],
    nativeStopCount: 1,
    canPromote: false,
    requiresConfirmation: true,
    canStopAndArchive: true,
    consultationTargets: [
      { ownerThreadId: owner.id, ownerTitle: owner.title, work: [{ threadId: child.id }] },
    ],
  };
  const loadArchiveFamily = vi.fn().mockResolvedValue(AsyncResult.success(family));
  const sendArchiveQuestion = vi.fn().mockResolvedValue(AsyncResult.success(undefined));
  const review = vi.fn();
  const click = (text: string) => {
    const button = state.alerts.at(-1)?.buttons.find((button) => button.text === text);
    expect(button).toBeDefined();
    button!.onPress?.();
  };
  return { owner, child, family, loadArchiveFamily, sendArchiveQuestion, review, click };
}

it("asks the selected execution owner through the ordinary queue and leaves the family unarchived", async () => {
  const test = setup();
  const pending = prepareLastCodeMobileThreadArchive(test.owner, test);
  await vi.waitFor(() => expect(state.alerts).toHaveLength(1));
  test.click("Review");
  test.click("Review agent work");
  expect(state.alerts.at(-1)?.message).toContain("Child work");
  test.click("Ask the agent");
  expect(await pending).toBeNull();
  expect(test.loadArchiveFamily).toHaveBeenCalledTimes(2);
  expect(test.sendArchiveQuestion).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      environmentId: test.owner.environmentId,
      input: expect.objectContaining({
        threadId: test.owner.id,
        dispatchMode: "queue",
        runtimeMode: test.owner.runtimeMode,
        interactionMode: test.owner.interactionMode,
      }),
    }),
  );
  expect(test.review).toHaveBeenCalledExactlyOnceWith({
    environmentId: test.owner.environmentId,
    threadId: test.owner.id,
  });
});

it("keeps newly busy-owner feedback visible without sending or granting archive consent", async () => {
  const test = setup();
  const pending = prepareLastCodeMobileThreadArchive(test.owner, test);
  await vi.waitFor(() => expect(state.alerts).toHaveLength(1));
  test.click("Review");
  test.click("Review agent work");
  test.loadArchiveFamily.mockResolvedValue(
    AsyncResult.success({
      ...test.family,
      consultationTargets: [{ ...test.family.consultationTargets![0]!, unavailableReason: "busy" }],
    }),
  );
  test.click("Ask the agent");
  await vi.waitFor(() => expect(state.alerts.at(-1)?.message).toContain("This agent is busy"));
  expect(test.sendArchiveQuestion).not.toHaveBeenCalled();
  test.click("Back");
  test.click("Cancel");
  expect(await pending).toBeNull();
  expect(test.review).not.toHaveBeenCalled();
});

it("uses the checkbox to opt into the displayed local and linked archive choices", async () => {
  const test = setup();
  const scratch = ProjectId.make("scratch");
  const environmentId = EnvironmentId.make("linked-machine");
  const linkedThread = {
    threadId: test.child.id,
    projectId: ProjectId.make("remote-project"),
    title: "Linked work",
  };
  const linkedCohort = {
    anchorThreadId: linkedThread.threadId,
    selectedThreadIds: [linkedThread.threadId],
    typedIn: [],
    childDisposition: "stop_and_archive",
  } as const;
  test.loadArchiveFamily.mockResolvedValue(
    AsyncResult.success({
      ...test.family,
      keptThreadIds: [test.child.id],
      archivePreview: {
        environmentId: test.owner.environmentId,
        typedInThreadIds: [test.child.id],
        temporaryProjects: [
          { projectId: scratch, title: "Scratch", threadIds: [], requiresTypedIn: false },
          {
            projectId: ProjectId.make("opt-in"),
            title: "Opt-in project",
            threadIds: [],
            requiresTypedIn: true,
          },
        ],
        threads: [test.owner, test.child].map(({ id, projectId, title }) => ({
          threadId: id,
          projectId,
          title,
        })),
      },
      linkedArchivePreview: [
        {
          environmentId,
          label: "Build machine",
          status: "ready",
          inventory: {
            environmentId,
            threads: [linkedThread],
            typedInThreadIds: [linkedThread.threadId],
            activeThreadIds: [linkedThread.threadId],
            unreadThreadIds: [],
            protectedThreadIds: [],
            keptThreadIds: [linkedThread.threadId],
            archiveChoices: { defaultCohorts: [], includingTypedInCohorts: [linkedCohort] },
          },
        },
      ],
    }),
  );
  const pending = prepareLastCodeMobileThreadArchive(test.owner, test);
  await vi.waitFor(() => expect(state.sheets).toHaveLength(1));
  const sheet = state.sheets[0]!;
  const defaultPreview = sheet.confirm(false);
  expect(defaultPreview.message).toContain("Keep open");
  expect(defaultPreview.message).toContain("Unarchiving won't restore them.\n\nScratch");
  expect(defaultPreview.message).not.toContain("Opt-in project");
  expect(defaultPreview.message).toContain(
    `Build machine\nLinked work · ${linkedThread.projectId} · Keep open · Working · You wrote in this thread`,
  );
  expect(defaultPreview.confirmLabel).toBe("Archive threads");
  sheet.accept({ includeTypedIn: false });
  expect(await pending).toMatchObject({
    participantIds: [test.owner.id],
    input: {
      expectedArchiveThreadIds: [test.owner.id],
      expectedChildThreadIds: [test.child.id],
      expectedTemporaryProjects: [{ projectId: scratch, threadIds: [] }],
      childDisposition: "archive_after_review",
      linkedArchiveSelection: [
        { environmentId, label: "Build machine", status: "ready", cohorts: [] },
      ],
    },
  });
  const optedIn = prepareLastCodeMobileThreadArchive(test.owner, test);
  await vi.waitFor(() => expect(state.sheets).toHaveLength(2));
  const optInSheet = state.sheets[1]!;
  const optInPreview = optInSheet.confirm(true);
  expect(optInPreview.message).toContain(
    `Build machine\nLinked work · ${linkedThread.projectId} · Archive · Working · You wrote in this thread`,
  );
  expect(optInPreview.message).toContain("Opt-in project");
  expect(optInPreview.confirmLabel).toBe("Stop active threads & archive");
  optInSheet.accept({ includeTypedIn: true });
  expect(await optedIn).toMatchObject({
    participantIds: [test.owner.id, test.child.id],
    input: {
      includeTypedInThreadIds: [test.child.id],
      childDisposition: "stop_and_archive",
      linkedArchiveSelection: [
        { environmentId, label: "Build machine", status: "ready", cohorts: [linkedCohort] },
      ],
    },
  });
});
