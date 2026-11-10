import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  UpdateDrainRequestId,
  UpdateDrainTargetVersion,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { UpdateDrainAdmission } from "../updateDrain/UpdateDrainAdmission.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";

const enrichment = {
  repositoryIdentity: null,
  faviconPath: null,
  repositoryIdentityResolved: false,
};
const layer = Layer.mergeAll(
  RuntimeLayer.layerProjectSetupScriptRunner,
  RuntimeLayer.layerProjectService,
).pipe(
  Layer.provideMerge(RuntimeLayer.layerUpdateDrainAdmission),
  Layer.provide(
    Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
      peek: () => Effect.succeed(enrichment),
      getAvailable: () => Effect.succeed(enrichment),
      invalidate: () => Effect.void,
    }),
  ),
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (root) => Effect.succeed(root),
    }),
  ),
  Layer.provide(
    Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
      getInstance: () => Effect.die("No providers in wiring test"),
      listInstances: Effect.succeed([]),
    }),
  ),
  Layer.provide(
    Layer.mock(TerminalManager)({
      refreshMetadata: Effect.succeed([]),
      open: () => Effect.die("Closed admission must never open a terminal"),
    }),
  ),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "admission-wiring-" })),
  Layer.provide(NodeServices.layer),
);

it.layer(layer)("production project/setup admission wiring", (it) => {
  it.effect("constructs the exported services and keeps both closed after activation", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const setup = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const admission = yield* UpdateDrainAdmission;
      const projectId = ProjectId.make("wiring-project");
      const scripts = [
        {
          id: "setup",
          name: "Setup",
          command: "example",
          icon: "test" as const,
          runOnWorktreeCreate: true,
        },
      ];
      yield* projects.create({
        commandId: CommandId.make("wiring:create"),
        projectId,
        title: "Wiring test",
        workspaceRoot: "/work/example",
        scripts,
      });
      const requestId = UpdateDrainRequestId.make("wiring-update");
      yield* admission.dispatch({
        type: "update-drain.start",
        commandId: CommandId.make("wiring:drain"),
        requestId,
        targetVersion: UpdateDrainTargetVersion.make("1.2.3"),
        createdAt: "2026-10-08T00:00:00.000Z",
      });
      yield* admission.claimActivation({ requestId });
      const deleted = yield* projects
        .delete({ commandId: CommandId.make("wiring:delete"), projectId, force: true })
        .pipe(Effect.flip);
      assert.equal(deleted._tag, "ProjectOperationError");
      if (deleted._tag === "ProjectOperationError")
        assert.equal((deleted.cause as { _tag: string })._tag, "UpdateDrainAdmissionError");
      const run = yield* setup
        .runForThread({ threadId: "wiring-thread", projectId, worktreePath: "/work/example-child" })
        .pipe(Effect.flip);
      assert.equal(run._tag, "ProjectSetupScriptOperationError");
      if (run._tag === "ProjectSetupScriptOperationError")
        assert.equal((run.cause as { _tag: string })._tag, "UpdateDrainAdmissionError");
    }),
  );
});
