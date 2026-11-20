import type { ProjectId } from "@t3tools/contracts";
import { mediaMimeTypeFromExtension } from "@t3tools/shared/mediaPreview";
import { isProjectFaviconPath } from "@t3tools/shared/projectFavicon";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import {
  PROJECT_FAVICON_ICNS_MIN_SIZE,
  resolveCanonicalFile,
  resolveCanonicalWorkspaceFile,
} from "./AssetAccess.ts";
import { extractIcnsPng } from "./icns.ts";
import { openMediaFile, readMediaFileHeader } from "./MediaFile.ts";
import { renderProjectIconSvg } from "./projectIconSvg.ts";

const PROJECT_ICON_MAX_BYTES = 128 * 1024;
// An ICNS container can include many larger representations of the same icon.
const PROJECT_ICON_ICNS_MAX_BYTES = 8 * 1024 * 1024;
const ICNS_HEADER_BYTES = 8;

// extractIcnsPng ranks entries by width only. Break the PNG signature of entries over the
// limit so it skips them and a smaller representation can win.
const hideOversizedIcnsEntries = (bytes: Uint8Array) => {
  if (bytes.length < ICNS_HEADER_BYTES) return bytes;
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = Math.min(data.getUint32(4), bytes.length);
  for (let offset = ICNS_HEADER_BYTES; offset + ICNS_HEADER_BYTES <= end;) {
    const length = data.getUint32(offset + 4);
    if (length < ICNS_HEADER_BYTES || offset + length > end) break;
    if (length - ICNS_HEADER_BYTES > PROJECT_ICON_MAX_BYTES) bytes[offset + ICNS_HEADER_BYTES] = 0;
    offset += length;
  }
  return bytes;
};

const readProjectFavicon = Effect.fn("ProjectIcon.readProjectFavicon")(
  function* (workspaceRoot: string, faviconPath: string | null) {
    const path = yield* Path.Path;
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
    const root = yield* workspacePaths.normalizeWorkspaceRoot(workspaceRoot);
    const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
    const resolved = yield* resolver.resolvePath(root, faviconPath ?? undefined);
    if (!resolved || !isProjectFaviconPath(resolved)) return null;

    const isExternalOverride =
      faviconPath !== null &&
      path.isAbsolute(faviconPath) &&
      path.normalize(resolved) === path.normalize(faviconPath);
    const filePath = yield* isExternalOverride
      ? resolveCanonicalFile(resolved)
      : resolveCanonicalWorkspaceFile({
          workspaceRoot: root,
          relativePath: path.relative(root, resolved),
        });
    if (!filePath || !isProjectFaviconPath(filePath)) return null;

    const extension = path.extname(filePath).toLowerCase();
    const isIcns = extension === ".icns";
    const mediaType = isIcns ? "image/png" : mediaMimeTypeFromExtension(extension);
    if (!mediaType?.startsWith("image/")) return null;

    const file = yield* openMediaFile(filePath);
    const limit = isIcns ? PROJECT_ICON_ICNS_MAX_BYTES : PROJECT_ICON_MAX_BYTES;
    if (!file || file.info.size === 0n || file.info.size > BigInt(limit)) return null;

    const size = Number(file.info.size);
    const bytes = yield* readMediaFileHeader(filePath, file, size + 1);
    if (bytes.byteLength !== size) return null;

    const icon = isIcns
      ? extractIcnsPng(hideOversizedIcnsEntries(bytes), PROJECT_FAVICON_ICNS_MIN_SIZE)
      : bytes;
    return icon ? { mediaType, base64: Buffer.from(icon).toString("base64") } : null;
  },
  Effect.scoped,
  Effect.catch((cause) =>
    Effect.logDebug("Could not read project favicon.", { cause }).pipe(Effect.as(null)),
  ),
);

/** Resolves a project's icon with the sidebar's precedence: glyph, configured image, favicon. */
export const readProjectIcon = Effect.fn("ProjectIcon.readProjectIcon")(function* (
  projectId: ProjectId,
) {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const project = yield* projects.get(projectId);
  if (Option.isNone(project)) return null;

  const override = project.value.projectIcon;
  if (override) {
    const bytes = Buffer.from(renderProjectIconSvg(override));
    return bytes.byteLength <= PROJECT_ICON_MAX_BYTES
      ? { mediaType: "image/svg+xml", base64: bytes.toString("base64") }
      : null;
  }

  return yield* readProjectFavicon(project.value.workspaceRoot, project.value.faviconPath);
});
