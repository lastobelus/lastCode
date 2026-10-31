import { parseActionResumeFollowUp } from "@t3tools/shared/actionResume";
import type { ThreadFeedMessage } from "../../lib/threadActivity";

export function parseActionResumeResultMessage(
  message: Pick<ThreadFeedMessage, "role" | "createdBy" | "text">,
) {
  if (message.role !== "user" || message.createdBy !== "system") return null;
  return parseActionResumeFollowUp(message.text);
}
