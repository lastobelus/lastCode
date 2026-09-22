import * as Schema from "effect/Schema";

export const README_FEATURES_START = "<!-- lastcode-features:start -->";
export const README_FEATURES_END = "<!-- lastcode-features:end -->";

const StableId = Schema.NonEmptyString.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/));
const SingleLineText = Schema.NonEmptyString.check(Schema.isPattern(/^[^\r\n]+$/));
const Client = Schema.Literals(["web", "desktop", "mobile"]);

const Feature = Schema.Struct({
  id: StableId,
  title: SingleLineText,
  readmeSummary: SingleLineText,
  pagePath: SingleLineText,
  supportedClients: Schema.Array(Client),
  sourcePrefixes: Schema.Array(SingleLineText),
  captureRecipeIds: Schema.Array(StableId),
});

const ReadmePanel = Schema.Struct({
  captureId: StableId,
  fileStem: StableId,
  alt: SingleLineText,
});

const LastCodeDocsFeatureRegistrySchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  siteBaseUrl: SingleLineText,
  features: Schema.Array(Feature),
  readme: Schema.Struct({
    intro: SingleLineText,
    featureIds: Schema.Array(StableId),
    panels: Schema.Array(ReadmePanel),
  }),
}).annotate({ parseOptions: { onExcessProperty: "error" } });

export type LastCodeDocsFeatureRegistry = typeof LastCodeDocsFeatureRegistrySchema.Type;
export type SourcePathKind = "file" | "directory";

export interface RegistryValidationOptions {
  readonly sourcePathKind?: (sourcePrefix: string) => SourcePathKind | undefined;
}

const decodeRegistry = Schema.decodeUnknownSync(LastCodeDocsFeatureRegistrySchema);
const decodeRegistryJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(LastCodeDocsFeatureRegistrySchema),
);

function requireUnique(values: ReadonlyArray<string>, label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`${label} contains duplicate value '${value}'.`);
    }
    seen.add(value);
  }
}

function validateSourcePrefix(
  sourcePrefix: string,
  sourcePathKind: RegistryValidationOptions["sourcePathKind"],
): void {
  const pathSegments = sourcePrefix.split("/").filter(Boolean);
  const containsGlob = /[*?[\]{}]/.test(sourcePrefix);
  if (
    sourcePrefix.startsWith("/") ||
    sourcePrefix.includes("\\") ||
    sourcePrefix.includes("//") ||
    containsGlob ||
    pathSegments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`Source prefix '${sourcePrefix}' must be a literal path prefix.`);
  }

  if (!sourcePathKind) {
    return;
  }

  const kind = sourcePathKind(sourcePrefix);
  if (!kind) {
    throw new Error(`Source prefix '${sourcePrefix}' does not exist.`);
  }
  const expectedKind = sourcePrefix.endsWith("/") ? "directory" : "file";
  if (kind !== expectedKind) {
    throw new Error(
      `Source prefix '${sourcePrefix}' must ${expectedKind === "directory" ? "end" : "not end"} with '/'.`,
    );
  }
}

export function decodeLastCodeDocsFeatureRegistry(value: unknown): LastCodeDocsFeatureRegistry {
  return decodeRegistry(value);
}

export function decodeLastCodeDocsFeatureRegistryJson(source: string): LastCodeDocsFeatureRegistry {
  return decodeRegistryJson(source);
}

export function validateLastCodeDocsFeatureRegistry(
  value: unknown,
  options: RegistryValidationOptions = {},
): LastCodeDocsFeatureRegistry {
  const registry = decodeRegistry(value);

  if (!registry.siteBaseUrl.startsWith("https://") || !registry.siteBaseUrl.endsWith("/")) {
    throw new Error("siteBaseUrl must be an HTTPS URL ending with '/'.");
  }
  if (registry.features.length === 0) {
    throw new Error("features must contain at least one feature.");
  }

  requireUnique(
    registry.features.map((feature) => feature.id),
    "Feature IDs",
  );
  requireUnique(
    registry.features.map((feature) => feature.pagePath),
    "Feature page paths",
  );

  const featureById = new Map(registry.features.map((feature) => [feature.id, feature]));
  const captureRecipeIds = new Set(
    registry.features.flatMap((feature) => feature.captureRecipeIds),
  );

  for (const feature of registry.features) {
    if (!/^\/features\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(feature.pagePath)) {
      throw new Error(`Feature '${feature.id}' pagePath must be a stable /features/<id>/ route.`);
    }
    if (feature.supportedClients.length === 0) {
      throw new Error(`Feature '${feature.id}' must name at least one supported client.`);
    }
    requireUnique(feature.supportedClients, `Feature '${feature.id}' supportedClients`);
    if (feature.sourcePrefixes.length === 0) {
      throw new Error(`Feature '${feature.id}' must name at least one source prefix.`);
    }
    requireUnique(feature.sourcePrefixes, `Feature '${feature.id}' sourcePrefixes`);
    for (const sourcePrefix of feature.sourcePrefixes) {
      validateSourcePrefix(sourcePrefix, options.sourcePathKind);
    }
    if (feature.captureRecipeIds.length === 0) {
      throw new Error(`Feature '${feature.id}' must name at least one capture recipe.`);
    }
    requireUnique(feature.captureRecipeIds, `Feature '${feature.id}' captureRecipeIds`);
  }

  if (registry.readme.featureIds.length === 0) {
    throw new Error("readme.featureIds must contain at least one feature.");
  }
  requireUnique(registry.readme.featureIds, "README feature IDs");
  for (const featureId of registry.readme.featureIds) {
    if (!featureById.has(featureId)) {
      throw new Error(`README feature ID '${featureId}' names an unknown feature.`);
    }
  }

  if (registry.readme.panels.length !== 2) {
    throw new Error("readme.panels must contain exactly two panels.");
  }
  requireUnique(
    registry.readme.panels.map((panel) => panel.captureId),
    "README panel capture IDs",
  );
  requireUnique(
    registry.readme.panels.map((panel) => panel.fileStem),
    "README panel file stems",
  );
  for (const panel of registry.readme.panels) {
    if (!captureRecipeIds.has(panel.captureId)) {
      throw new Error(`README panel '${panel.captureId}' names an unknown capture recipe.`);
    }
  }

  return registry;
}

function renderPanel(registry: LastCodeDocsFeatureRegistry, panelIndex: number): string {
  const panel = registry.readme.panels[panelIndex];
  if (!panel) {
    throw new Error(`README panel ${panelIndex + 1} is missing.`);
  }
  const imageUrl = `${registry.siteBaseUrl}media/readme/${panel.fileStem}-dark.png`;
  const escapedImageUrl = escapeHtmlAttribute(imageUrl);
  return [
    "<picture>",
    `  <source media="(prefers-color-scheme: dark)" srcset="${escapedImageUrl}">`,
    `  <img src="${escapedImageUrl}" alt="${escapeHtmlAttribute(panel.alt)}">`,
    "</picture>",
  ].join("\n");
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function renderLastCodeReadmeFeatureBlock(registry: LastCodeDocsFeatureRegistry): string {
  const featureById = new Map(registry.features.map((feature) => [feature.id, feature]));
  const featureLines = registry.readme.featureIds.map((featureId) => {
    const feature = featureById.get(featureId);
    if (!feature) {
      throw new Error(`README feature ID '${featureId}' names an unknown feature.`);
    }
    const pageUrl = `${registry.siteBaseUrl}${feature.pagePath.slice(1)}`;
    return `- [**${feature.title}**](${pageUrl}) — ${feature.readmeSummary}`;
  });

  return [
    README_FEATURES_START,
    "",
    "## What LastCode adds",
    "",
    registry.readme.intro,
    "",
    renderPanel(registry, 0),
    "",
    ...featureLines,
    "",
    renderPanel(registry, 1),
    "",
    README_FEATURES_END,
  ].join("\n");
}

function markerRange(readme: string): { readonly start: number; readonly end: number } | null {
  const starts = [...readme.matchAll(new RegExp(README_FEATURES_START, "g"))];
  const ends = [...readme.matchAll(new RegExp(README_FEATURES_END, "g"))];

  if (starts.length === 0 && ends.length === 0) {
    return null;
  }
  const start = starts[0]?.index;
  const endStart = ends[0]?.index;
  if (starts.length !== 1 || ends.length !== 1 || start === undefined || endStart === undefined) {
    throw new Error("README must contain one ordered LastCode feature marker pair.");
  }
  const end = endStart + README_FEATURES_END.length;
  if (start >= endStart) {
    throw new Error("README must contain one ordered LastCode feature marker pair.");
  }
  return { start, end };
}

export function replaceLastCodeReadmeFeatureBlock(
  readme: string,
  registry: LastCodeDocsFeatureRegistry,
): string {
  const range = markerRange(readme);
  if (!range) {
    throw new Error("README feature markers are not active.");
  }
  return `${readme.slice(0, range.start)}${renderLastCodeReadmeFeatureBlock(registry)}${readme.slice(range.end)}`;
}

export function checkLastCodeReadmeFeatureBlock(
  readme: string,
  registry: LastCodeDocsFeatureRegistry,
): { readonly active: boolean; readonly current: boolean } {
  const range = markerRange(readme);
  if (!range) {
    return { active: false, current: true };
  }
  const current =
    readme.slice(range.start, range.end) === renderLastCodeReadmeFeatureBlock(registry);
  return { active: true, current };
}
