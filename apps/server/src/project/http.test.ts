import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  type AuthEnvironmentScope,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  Project,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ProjectCloneTracker from "./ProjectCloneTracker.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectHttp from "./http.ts";

class ProjectTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.projects) {}
const decodeProject = Schema.decodeUnknownSync(Project);

it.effect(
  "denies HTTP saved-data disposal without source-control authority before executing deletion",
  () =>
    Effect.gen(function* () {
      const scopes = new Set<AuthEnvironmentScope>([
        "environment:maintain",
        "filesystem:read",
        "filesystem:write",
        "orchestration:operate",
      ]);
      const deleted = decodeProject({
        id: "project",
        title: "Example",
        workspaceRoot: "/example/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: "2026-01-01T00:00:00.000Z",
      });
      let deleteCount = 0;
      let enqueueCount = 0;
      const routes = HttpApiBuilder.layer(ProjectTestApi).pipe(
        Layer.provide(ProjectHttp.layer),
        Layer.provide(
          Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
            effect.pipe(
              Effect.provideService(EnvironmentAuthenticatedPrincipal, {
                sessionId: AuthSessionId.make("test-session"),
                subject: "test",
                method: "bearer-access-token",
                scopes,
              }),
            ),
          ),
        ),
        Layer.provide(
          Layer.mock(ProjectService.ProjectService)({
            delete: () =>
              Effect.sync(() => {
                deleteCount += 1;
                return deleted;
              }),
          }),
        ),
        Layer.provide(
          Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ discard: () => Effect.void }),
        ),
        Layer.provide(
          Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
            enqueueCommand: (effect) =>
              Effect.sync(() => {
                enqueueCount += 1;
              }).pipe(Effect.andThen(effect)),
          }),
        ),
        Layer.provide(HttpPlatform.layer),
        Layer.provide(Etag.layerWeak),
        Layer.provide(NodeServices.layer),
      );
      const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
      yield* Effect.addFinalizer(() => Effect.promise(dispose));
      const remove = () =>
        Effect.promise(() =>
          handler(
            new Request("http://localhost/api/projects/mutate", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                type: "project.delete",
                commandId: "delete",
                projectId: "project",
                savedWorkspace: { mode: "discard", previewToken: "exact-preview" },
              }),
            }),
          ),
        );
      const denied = yield* remove();
      expect(denied.status).toBe(403);
      expect(yield* Effect.promise(() => denied.json())).toMatchObject({
        code: "insufficient_scope",
        requiredPermission: "source-control:write",
      });
      expect(enqueueCount).toBe(0);
      expect(deleteCount).toBe(0);

      scopes.add("source-control:write");
      const allowed = yield* remove();
      expect(allowed.status).toBe(200);
      expect(enqueueCount).toBe(1);
      expect(deleteCount).toBe(1);
    }).pipe(Effect.scoped),
);
