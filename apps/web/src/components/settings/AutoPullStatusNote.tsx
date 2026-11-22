import type {
  EnvironmentId,
  ProjectAutoPullStatus,
  ProjectId,
  TimestampFormat,
} from "@t3tools/contracts";
import { msg, useMessages } from "gt-react";

import { useClientSettings } from "../../hooks/useSettings";
import { m, type MessageResolver } from "../../i18n/messages";
import { useEnvironmentQuery } from "../../state/query";
import { projectEnvironment } from "../../state/projects";
import { formatDayAwareTimestamp } from "../../timestampFormat";

function describeAutoPullStatus(
  status: ProjectAutoPullStatus,
  timestampFormat: TimestampFormat,
  resolve: MessageResolver = m,
): string {
  const at = (isoDate: string) => formatDayAwareTimestamp(isoDate, timestampFormat);
  switch (status.result) {
    case "pulled":
      return resolve(msg("Pulled at {time}.", { time: at(status.lastAttemptAt) }));
    case "up-to-date":
      return resolve(msg("Up to date as of {time}.", { time: at(status.lastAttemptAt) }));
    case "skipped":
    case "failed": {
      const variables = {
        time: at(status.lastAttemptAt),
        reason: status.reason ?? resolve(msg("no reason given")),
      };
      const last =
        status.result === "skipped"
          ? resolve(msg("Last skipped at {time}: {reason}.", variables))
          : resolve(msg("Last failed at {time}: {reason}.", variables));
      const success =
        status.lastSuccessAt === null
          ? resolve(msg("Not confirmed current since the server started."))
          : resolve(msg("Last current at {time}.", { time: at(status.lastSuccessAt) }));
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
  const resolve = useMessages();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  // Older servers lack this method; their error leaves the note empty.
  const { data, isSuccess } = useEnvironmentQuery(
    projectEnvironment.autoPullStatus({ environmentId, input: { projectId } }),
    resolve,
  );
  if (!isSuccess) return null;
  return data === null
    ? resolve(msg("Not checked since the server started."))
    : describeAutoPullStatus(data, timestampFormat, resolve);
}
