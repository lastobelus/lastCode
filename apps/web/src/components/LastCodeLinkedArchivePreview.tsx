import {
  type buildThreadArchiveConfirmation,
  LINKED_ARCHIVE_EMPTY_MESSAGE,
} from "@t3tools/client-runtime/state/thread-archive";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useGT, useMessages } from "gt-react";
import { readProject } from "../state/entities";

export function LastCodeLinkedArchivePreview({
  machines,
}: {
  readonly machines: ReturnType<typeof buildThreadArchiveConfirmation>["linkedMachines"];
}) {
  const gt = useGT();
  const messages = useMessages();
  if (!machines.length) return null;
  return (
    <ul
      aria-label={gt("Linked machines")}
      className="max-h-48 space-y-3 overflow-y-auto overscroll-contain text-sm"
    >
      {machines.map(({ environmentId, label, warnings, threads }) => (
        <li key={environmentId} className="space-y-1">
          <h3 className="wrap-anywhere font-medium">{label}</h3>
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
          ) : !warnings.length ? (
            <p className="text-muted-foreground">{messages(LINKED_ARCHIVE_EMPTY_MESSAGE)}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
