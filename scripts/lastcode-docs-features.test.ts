import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  checkLastCodeReadmeFeatureBlock,
  type LastCodeDocsFeatureRegistry,
  README_FEATURES_END,
  README_FEATURES_START,
  renderLastCodeReadmeFeatureBlock,
  replaceLastCodeReadmeFeatureBlock,
  validateLastCodeDocsFeatureRegistry,
} from "./lib/lastcode-docs-features.ts";
import { loadLastCodeDocsFeatureRegistry } from "./lastcode-docs-features.ts";

interface MutableFeatureRegistry {
  schemaVersion: number;
  siteBaseUrl: string;
  features: Array<{
    id: string;
    title: string;
    readmeSummary: string;
    pagePath: string;
    supportedClients: Array<string>;
    sourcePrefixes: Array<string>;
    captureRecipeIds: Array<string>;
  }>;
  readme: {
    intro: string;
    featureIds: Array<string>;
    panels: Array<{ captureId: string; fileStem: string; alt: string }>;
  };
}

const RepositoryRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);

const loadRegistry = Effect.fn("loadRegistryFixture")(function* () {
  return yield* loadLastCodeDocsFeatureRegistry(yield* RepositoryRoot);
});

function mutableRegistry(registry: LastCodeDocsFeatureRegistry): MutableFeatureRegistry {
  return structuredClone(registry) as MutableFeatureRegistry;
}

function fixturePathKind(sourcePrefix: string) {
  if (sourcePrefix === "missing.ts") {
    return undefined;
  }
  return sourcePrefix.endsWith("/") ? ("directory" as const) : ("file" as const);
}

it.layer(NodeServices.layer)("LastCode docs feature registry", (it) => {
  it.effect("validates the checked-in registry and its source paths", () =>
    Effect.gen(function* () {
      const registry = yield* loadRegistry();

      assert.equal(registry.schemaVersion, 1);
      assert.deepStrictEqual(
        registry.features.map((feature) => feature.id),
        [
          "resumable-actions",
          "codex-thread-tools",
          "thread-annotations",
          "legacy-sidebar",
          "local-nightly-updates",
        ],
      );
      assert.deepStrictEqual(registry.features[0]?.supportedClients, ["web", "desktop", "mobile"]);
      assert.deepStrictEqual(registry.features[4]?.supportedClients, ["desktop"]);
    }),
  );

  it.effect("keeps the approved resumable-actions summary verbatim", () =>
    Effect.gen(function* () {
      const registry = yield* loadRegistry();

      assert.equal(
        registry.features[0]?.readmeSummary,
        "Agents can start a Project Action and then pause while it runs. LastCode wakes the thread when the Action finishes; in the meantime, you can inspect or cancel it. We added this because we were tired of paying the polling tax: wasting turns and tokens checking whether a command was done.",
      );
    }),
  );

  it.effect("keeps the approved public registry contract", () =>
    Effect.gen(function* () {
      const registry = yield* loadRegistry();
      const publicFeatures = registry.features.map((feature) => ({
        id: feature.id,
        title: feature.title,
        readmeSummary: feature.readmeSummary,
        pagePath: feature.pagePath,
        supportedClients: feature.supportedClients,
        captureRecipeIds: feature.captureRecipeIds,
      }));

      assert.deepStrictEqual(publicFeatures, [
        {
          id: "resumable-actions",
          title: "Resumable project actions",
          readmeSummary:
            "Agents can start a Project Action and then pause while it runs. LastCode wakes the thread when the Action finishes; in the meantime, you can inspect or cancel it. We added this because we were tired of paying the polling tax: wasting turns and tokens checking whether a command was done.",
          pagePath: "/features/resumable-actions/",
          supportedClients: ["web", "desktop", "mobile"],
          captureRecipeIds: ["resumable-actions", "workspace-overview"],
        },
        {
          id: "codex-thread-tools",
          title: "Codex thread tools",
          readmeSummary:
            "Let Codex list and inspect LastCode threads, read bounded recent context, and send tracked follow-up work.",
          pagePath: "/features/codex-thread-tools/",
          supportedClients: ["web", "desktop", "mobile"],
          captureRecipeIds: ["codex-thread-tools"],
        },
        {
          id: "thread-annotations",
          title: "Thread annotations",
          readmeSummary:
            "Attach a short note to a thread so its current purpose stays visible in chat and the sidebar; resolve or reopen it as the work changes.",
          pagePath: "/features/thread-annotations/",
          supportedClients: ["web", "desktop"],
          captureRecipeIds: ["thread-annotations", "workspace-overview"],
        },
        {
          id: "legacy-sidebar",
          title: "Legacy sidebar conveniences",
          readmeSummary:
            "Use the compact project-and-thread layout with adjustable scale, status indicators, and worktree context.",
          pagePath: "/features/legacy-sidebar/",
          supportedClients: ["web", "desktop"],
          captureRecipeIds: ["workspace-overview"],
        },
        {
          id: "local-nightly-updates",
          title: "Local nightly updates",
          readmeSummary:
            "On Apple Silicon macOS, follow T3 Code nightlies, inspect changes, and build or install isolated LastCode revisions locally.",
          pagePath: "/features/local-nightly-updates/",
          supportedClients: ["desktop"],
          captureRecipeIds: ["local-nightly-updates"],
        },
      ]);
      assert.deepStrictEqual(
        registry.readme.featureIds,
        publicFeatures.map(({ id }) => id),
      );
      assert.deepStrictEqual(registry.readme.panels, [
        {
          captureId: "workspace-overview",
          fileStem: "workspace",
          alt: "LastCode in the Ocean theme with a scaled legacy sidebar, a thread annotation, and a resumable action running in the active chat.",
        },
        {
          captureId: "local-nightly-updates",
          fileStem: "local-nightly",
          alt: "LastCode's desktop update panel showing release notes and progress for a local nightly build.",
        },
      ]);

      const sourcePrefixes = new Map(
        registry.features.map((feature) => [feature.id, feature.sourcePrefixes]),
      );
      assert.includeMembers(
        [...(sourcePrefixes.get("codex-thread-tools") ?? [])],
        ["apps/server/src/provider/Layers/CodexAdapter.ts"],
      );
      assert.includeMembers(
        [...(sourcePrefixes.get("thread-annotations") ?? [])],
        ["apps/server/src/orchestration/decider.ts", "apps/server/src/orchestration/projector.ts"],
      );
      assert.includeMembers(
        [...(sourcePrefixes.get("local-nightly-updates") ?? [])],
        ["apps/desktop/src/updates/DesktopUpdates.ts"],
      );
    }),
  );

  it.effect("rejects duplicate stable IDs", () =>
    Effect.gen(function* () {
      const fixture = mutableRegistry(yield* loadRegistry());
      fixture.features[1]!.id = fixture.features[0]!.id;

      assert.throws(
        () =>
          validateLastCodeDocsFeatureRegistry(fixture, {
            sourcePathKind: fixturePathKind,
          }),
        /duplicate value/,
      );
    }),
  );

  it.effect("rejects globs and missing source prefixes", () =>
    Effect.gen(function* () {
      const globFixture = mutableRegistry(yield* loadRegistry());
      globFixture.features[0]!.sourcePrefixes[0] = "apps/web/src/*.tsx";
      assert.throws(
        () =>
          validateLastCodeDocsFeatureRegistry(globFixture, {
            sourcePathKind: fixturePathKind,
          }),
        /must be a literal path prefix/,
      );

      const missingFixture = mutableRegistry(yield* loadRegistry());
      missingFixture.features[0]!.sourcePrefixes[0] = "missing.ts";
      assert.throws(
        () =>
          validateLastCodeDocsFeatureRegistry(missingFixture, {
            sourcePathKind: fixturePathKind,
          }),
        /does not exist/,
      );
    }),
  );

  it.effect("rejects stale README feature and panel references", () =>
    Effect.gen(function* () {
      const featureFixture = mutableRegistry(yield* loadRegistry());
      featureFixture.readme.featureIds[0] = "unknown-feature";
      assert.throws(
        () =>
          validateLastCodeDocsFeatureRegistry(featureFixture, {
            sourcePathKind: fixturePathKind,
          }),
        /unknown feature/,
      );

      const panelFixture = mutableRegistry(yield* loadRegistry());
      panelFixture.readme.panels[0]!.captureId = "unknown-capture";
      assert.throws(
        () =>
          validateLastCodeDocsFeatureRegistry(panelFixture, {
            sourcePathKind: fixturePathKind,
          }),
        /unknown capture recipe/,
      );
    }),
  );

  it.effect("allows the README to remain a short feature selection", () =>
    Effect.gen(function* () {
      const fixture = mutableRegistry(yield* loadRegistry());
      fixture.features.push({
        ...fixture.features[0]!,
        id: "future-feature",
        title: "Future feature",
        pagePath: "/features/future-feature/",
        sourcePrefixes: ["docs/user/project-settings.md"],
        captureRecipeIds: ["future-feature"],
      });

      const registry = validateLastCodeDocsFeatureRegistry(fixture, {
        sourcePathKind: fixturePathKind,
      });
      assert.equal(registry.features.length, 6);
      assert.equal(registry.readme.featureIds.length, 5);
    }),
  );

  it.effect("renders the approved feature order and dark panel fallbacks", () =>
    Effect.gen(function* () {
      const block = renderLastCodeReadmeFeatureBlock(yield* loadRegistry());

      assert.ok(block.startsWith(README_FEATURES_START));
      assert.ok(block.endsWith(README_FEATURES_END));
      assert.equal(block.match(/<picture>/g)?.length, 2);
      assert.ok(block.includes("media/readme/workspace-dark.png"));
      assert.ok(block.includes("media/readme/local-nightly-dark.png"));
      assert.ok(!block.includes("-light.png"));
      assert.ok(block.indexOf("Resumable project actions") < block.indexOf("Codex thread tools"));
    }),
  );

  it.effect("escapes README panel HTML attributes", () =>
    Effect.gen(function* () {
      const fixture = mutableRegistry(yield* loadRegistry());
      fixture.readme.panels[0]!.alt = 'The "Actions" panel uses <status> & progress.';

      const registry = validateLastCodeDocsFeatureRegistry(fixture, {
        sourcePathKind: fixturePathKind,
      });
      const block = renderLastCodeReadmeFeatureBlock(registry);

      assert.include(
        block,
        'alt="The &quot;Actions&quot; panel uses &lt;status&gt; &amp; progress."',
      );
      assert.notInclude(block, 'alt="The "Actions" panel');
    }),
  );

  it.effect("replaces only the delimited block and is idempotent", () =>
    Effect.gen(function* () {
      const registry = yield* loadRegistry();
      const readme = [
        "before",
        README_FEATURES_START,
        "old content",
        README_FEATURES_END,
        "after",
      ].join("\n");

      const generated = replaceLastCodeReadmeFeatureBlock(readme, registry);

      assert.ok(generated.startsWith("before\n"));
      assert.ok(generated.endsWith("\nafter"));
      assert.ok(!generated.includes("old content"));
      assert.equal(replaceLastCodeReadmeFeatureBlock(generated, registry), generated);
    }),
  );

  it.effect("does not require the inactive README block", () =>
    Effect.gen(function* () {
      const registry = yield* loadRegistry();
      assert.deepStrictEqual(checkLastCodeReadmeFeatureBlock("# LastCode\n", registry), {
        active: false,
        current: true,
      });
      assert.throws(
        () => replaceLastCodeReadmeFeatureBlock("# LastCode\n", registry),
        /README feature markers are not active/,
      );
    }),
  );

  it.effect("rejects incomplete or duplicate marker pairs", () =>
    Effect.gen(function* () {
      const registry = yield* loadRegistry();
      assert.throws(
        () => checkLastCodeReadmeFeatureBlock(README_FEATURES_START, registry),
        /one ordered LastCode feature marker pair/,
      );
      assert.throws(
        () =>
          checkLastCodeReadmeFeatureBlock(
            `${README_FEATURES_START}\n${README_FEATURES_START}\n${README_FEATURES_END}`,
            registry,
          ),
        /one ordered LastCode feature marker pair/,
      );
    }),
  );
});
