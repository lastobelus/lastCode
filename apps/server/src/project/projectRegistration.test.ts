import { assert, it } from "@effect/vitest";
import { CommandId, EnvironmentId, EventId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { planProjectCommand, type ProjectCommand } from "../orchestration-v2/ProjectCommands.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { temporaryProjectsOwnedBy } from "./projectRegistration.ts";

it.layer(ProjectStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)))(
  "project registration",
  (it) => {
    it.effect(
      "persists the owner, lists only matching temporary projects, and keeps one in place",
      () =>
        Effect.gen(function* () {
          const store = yield* ProjectStore.ProjectStoreV2;
          const owner = {
            environmentId: EnvironmentId.make("source"),
            threadId: ThreadId.make("launcher"),
          };
          const now = yield* DateTime.now;
          const apply = (command: ProjectCommand, sequence: number) =>
            Effect.gen(function* () {
              const project = Option.getOrUndefined(yield* store.get(command.projectId));
              const event = Result.getOrThrow(
                planProjectCommand({
                  command,
                  now,
                  eventId: EventId.make(command.commandId),
                  state: { project, workspaceOwner: undefined },
                }),
              );
              yield* store.apply({ ...event, sequence });
            });
          const projectId = ProjectId.make("temporary");
          const registration = { owner, temporary: true } as const;
          yield* apply(
            {
              type: "project.create",
              projectId,
              registration,
              title: "Disposable workspace",
              commandId: CommandId.make("create"),
              workspaceRoot: "/home/user/temp",
            },
            1,
          );
          yield* apply(
            {
              type: "project.create",
              projectId: ProjectId.make("ordinary"),
              registration: { owner },
              title: "Ordinary workspace",
              commandId: CommandId.make("create-ordinary"),
              workspaceRoot: "/home/user/ordinary",
            },
            2,
          );
          yield* apply(
            {
              type: "project.meta.update",
              projectId,
              title: "Renamed",
              commandId: CommandId.make("rename"),
            },
            3,
          );
          const owned = temporaryProjectsOwnedBy(yield* store.list(), owner);
          assert.deepEqual(
            owned.map((row) => row.projectId),
            [projectId],
          );
          assert.deepEqual(
            temporaryProjectsOwnedBy(owned, {
              ...owner,
              environmentId: EnvironmentId.make("different"),
            }),
            [],
          );
          assert.deepEqual(owned[0]?.registration, registration);
          assert.strictEqual(Option.getOrThrow(yield* store.getShell(projectId)).temporary, true);

          yield* apply(
            {
              type: "project.meta.update",
              projectId,
              keepTemporary: true,
              commandId: CommandId.make("keep"),
            },
            4,
          );
          const kept = Option.getOrThrow(yield* store.get(projectId));
          assert.deepEqual(kept.registration, { owner });
          assert.strictEqual(kept.title, "Renamed");
          assert.strictEqual(kept.archivedAt, null);
          assert.strictEqual(
            Option.getOrThrow(yield* store.getShell(projectId)).temporary,
            undefined,
          );
          assert.deepEqual(temporaryProjectsOwnedBy(yield* store.list(), owner), []);
        }),
    );
  },
);
