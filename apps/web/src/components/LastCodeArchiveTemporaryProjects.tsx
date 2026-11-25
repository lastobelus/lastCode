import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import type { buildThreadArchiveConfirmation } from "@t3tools/client-runtime/state/thread-archive";

export function LastCodeArchiveTemporaryProjects({
  temporaryProjects,
  temporaryProjectsWarning,
}: Pick<
  ReturnType<typeof buildThreadArchiveConfirmation>,
  "temporaryProjects" | "temporaryProjectsWarning"
>) {
  if (temporaryProjectsWarning === null) return null;
  return (
    <div className="space-y-1 text-sm">
      <p>{temporaryProjectsWarning}</p>
      <ul className="max-h-32 list-disc space-y-1 overflow-y-auto pl-5">
        {temporaryProjects.map((project) => (
          <li key={scopedProjectKey(project)} className="wrap-anywhere">
            {project.title}
          </li>
        ))}
      </ul>
    </div>
  );
}
