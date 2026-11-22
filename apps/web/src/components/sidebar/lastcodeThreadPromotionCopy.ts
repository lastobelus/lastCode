import { msg } from "gt-react";

export const promoteThreadLabel = msg("Promote");
export const returnThreadToOwnerLabel = msg("Return to owner");
export const remoteOwnerStateUnchecked = msg(
  "Owner is on another machine. Its state there wasn't checked.",
);
export const threadOwnershipUnavailable = msg("This thread's owner can't be changed.");
export const threadOwnerUnavailable = msg(
  "Can't return: the owner thread is missing, archived, or being archived.",
);
export const delegatedTaskInFlight = msg(
  "Still working for the thread that asked for it. Wait for it to finish or cancel it, then promote.",
);
export const threadOwnershipChangeFailed = msg("Couldn't change thread owner");
