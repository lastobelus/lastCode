import type {
  EnvironmentId,
  ProjectAutoPullStatus,
  ProjectId,
  TimestampFormat,
} from "@t3tools/contracts";

import { useClientSettings } from "../../hooks/useSettings";
import { useEnvironmentQuery } from "../../state/query";
import { projectEnvironment } from "../../state/projects";
import { formatDayAwareTimestamp } from "../../timestampFormat";

function describeAutoPullStatus(
  status: ProjectAutoPullStatus,
  timestampFormat: TimestampFormat,
): string {
  const at = (isoDate: string) => formatDayAwareTimestamp(isoDate, timestampFormat);
  switch (status.result) {
    case "pulled":
      return `Pulled at ${at(status.lastAttemptAt)}.`;
    case "up-to-date":
      return `Up to date as of ${at(status.lastAttemptAt)}.`;
    case "skipped":
    case "failed": {
      const last = `Last ${status.result === "skipped" ? "skipped" : "failed"} at ${at(status.lastAttemptAt)}: ${status.reason ?? "no reason given"}.`;
      const success =
        status.lastSuccessAt === null
          ? "Not confirmed current since the server started."
          : `Last current at ${at(status.lastSuccessAt)}.`;
      return `${last} ${success}`;
    }
  }
}

export function AutoPullStatusNote({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  // Older servers lack this method; their error leaves the note empty.
  const { data, isSuccess } = useEnvironmentQuery(
    projectEnvironment.autoPullStatus({ environmentId, input: { projectId } }),
  );
  if (!isSuccess) return null;
  return data === null
    ? "Not checked since the server started."
    : describeAutoPullStatus(data, timestampFormat);
}
