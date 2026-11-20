import {
  type buildLinkedArchiveRecovery,
  type buildThreadArchiveConfirmation,
  LINKED_ARCHIVE_EMPTY_MESSAGE,
} from "@t3tools/client-runtime/state/thread-archive";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useGT, useMessages } from "gt-react";
import { readProject } from "../state/entities";

export function LastCodeLinkedArchivePreview({
  machines,
  statuses,
}: {
  readonly machines: ReturnType<typeof buildThreadArchiveConfirmation>["linkedMachines"];
  readonly statuses?:
    | NonNullable<ReturnType<typeof buildLinkedArchiveRecovery>>["machines"]
    | undefined;
}) {
  const gt = useGT();
  const messages = useMessages();
  const previews = new Map(machines.map((machine) => [machine.environmentId, machine]));
  const rows = statuses ?? machines;
  if (!rows.length) return null;
  return (
    <ul
      aria-label={gt("Linked machines")}
      className="max-h-48 space-y-3 overflow-y-auto overscroll-contain text-sm"
    >
      {rows.map((row) => {
        const { environmentId, label } = row;
        const preview = previews.get(environmentId);
        const status = "status" in row ? row.status : undefined;
        const warnings = preview?.warnings ?? [];
        const threads = preview?.threads ?? [];
        return (
          <li key={environmentId} className="space-y-1">
            <h3 className="wrap-anywhere font-medium">{label}</h3>
            {status && <p className="text-muted-foreground">{status}</p>}
            {warnings.map((warning) => (
              <p key={warning} className="text-muted-foreground">
                {warning}
              </p>
            ))}
            {threads.length ? (
              <ul className="space-y-1">
                {threads.map(({ threadId, title, projectId, projectTitle, label }) => (
                  <li key={threadId} className="wrap-anywhere">
                    {title} ·{" "}
                    {projectTitle ??
                      readProject(scopeProjectRef(environmentId, projectId))?.title ??
                      projectId}
                    <span className="block text-xs text-muted-foreground">{label}</span>
                  </li>
                ))}
              </ul>
            ) : preview && !warnings.length ? (
              <p className="text-muted-foreground">{messages(LINKED_ARCHIVE_EMPTY_MESSAGE)}</p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
