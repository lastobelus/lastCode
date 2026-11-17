import { type EnvironmentId, OrchestratorMcpFailure } from "@t3tools/contracts";

const askAuthorization = (question: string) =>
  `If any structured-question tool is available, call it now with the question below; an asynchronous question tool also counts as available. Do not only quote the question in your final response when such a tool is available. Copy it unabridged, replacing <reference> with the returned ready-to-paste Markdown link exactly as returned. If no link was returned, identify the reference using its supplied metadata without inventing a URL. ${JSON.stringify(question)} Only when no structured-question tool is available, send the same text as a message; the user's next message, with the thread attached, is their answer. This client route remains unavailable until that answer authorizes the reference.`;

const threadReadMessages = {
  expiredGrant:
    "The client read grant for this reference has expired or is no longer usable. Expiry alone needs no client reapproval: a fresh authorization of this exact reference restores reading. " +
    askAuthorization(
      "My read grant for <reference> is no longer usable. From a client that can read that thread, answer this question with that thread attached. Grant expiry alone does not require client reapproval.",
    ),
  lostGrant:
    "The destination read was sent and answered, but the retained client read grant it relied on is now gone, with no recorded reason, so its result was discarded; this does not show whether the grant was revoked or expired. Ask the user a structured question that names this reference with its returned link verbatim, and have them answer it with this exact reference attached, from a client that can read the thread. If this provider cannot ask structured questions, ask the user to attach the reference to a new message instead. Do not read again until they have.",
  noGrant:
    'This run holds no client read grant for this reference, so no destination request was sent. If an independently authorized link might reach this environment, start a fresh read with the same environmentId and threadId and via: "reference" to use it. If only the user\'s client can reach the thread, ask the user a structured question that names this reference with its returned link verbatim, and have them answer it with the reference attached, from the client that can read it. If this provider cannot ask structured questions, the user must attach the reference to a new message instead.',
  disconnected:
    'The retained client read grant is still valid, but its client is disconnected, so no destination request was sent. Ask the user to reconnect that client, then retry; no new message or authorization is needed. A fresh read with via: "reference" may instead use an independently authorized link.',
  reauthenticate:
    "This client's session can no longer authorize reads: it is out of date or has expired. " +
    askAuthorization(
      "I can't read <reference> because your client session is out of date or has expired. First, sign in to that client again or reconnect it, and re-pair it if it uses a saved cookie or reusable credential. Then, from the new session on a client that can read that thread, answer this question with that thread attached. An answer from the old session won't restore access.",
    ),
  revoked:
    "The client's read authorization was revoked. Ask the user to approve the client again in its connection settings, then authorize this reference again. Do not retry this read through another route.",
  unavailable:
    "The authorized client could not complete the destination read. This does not prove the thread is missing. Ask the user to reconnect or update the source connection, then retry the same route. Do not switch routes after an attempted or uncertain read.",
  denied:
    "The source connection does not permit reading this thread. Ask the user to grant read access there, then retry the same route. Do not switch routes to bypass this refusal.",
  unsupported:
    "The source environment needs a server update to read this thread reference. Ask the user to update it, then retry the same route. Do not switch routes after this attempted read.",
  noDestination:
    'The authorized client has no enabled, supported connection to this exact environment, so no destination request was sent. Ask the user to enable or update that connection, or start a fresh read with via: "reference" to use an independently authorized link.',
  fence:
    "This server cannot verify its thread-read authorization records, so no read was authorized. Restarting or updating the server lets it repair them; then the user reconnects the client and authorizes this reference again.",
} as const;

export type ThreadReadDiagnostic = keyof typeof threadReadMessages;

const referenceReadMessages = {
  revoked:
    'This via: "reference" read already checked both routes: the client\'s retained read authorization was revoked, and no usable peer link reaches the environment, so no request was sent. Tell the user both steps for client recovery: (1) approve that client again in its connection settings; (2) reauthorize reading this exact reference from that client. Approval alone does not restore the reference grant. Wait for client reapproval before asking the authorization question; its answer must attach this exact reference from a client that can read the thread. If this provider cannot ask structured questions, the user can attach the reference to a new message after reapproval instead. Once the client\'s authority or connection, or a peer link, changes, start a fresh via: "reference" read; before then it fails the same way.',
  noGrant:
    'This via: "reference" read already checked both routes: no client read grant is retained for this reference, and no peer link reaches its environment, so no request was sent. Ask the user a structured question that names this reference with its returned link verbatim, and have them answer it with this exact reference attached, from a client that can read the thread. If this provider cannot ask structured questions, ask the user to attach the reference to a new message instead. Once they have, start a fresh via: "reference" read; before then it fails the same way.',
  disconnected:
    'This via: "reference" read already checked both routes: the retained client read grant is still valid, but its client is disconnected, and no peer link reaches the environment, so no request was sent. Ask the user to reconnect that same client; no new message or authorization is needed. Once it is connected, start a fresh via: "reference" read; before then it fails the same way.',
  noDestination:
    'This via: "reference" read already checked both routes: the authorized client has no enabled, supported connection to this environment, and no peer link reaches it, so no request was sent. Ask the user to enable or update that client connection, or to link this environment. Once one of those changes, start a fresh via: "reference" read; before then it fails the same way.',
} as const;

export const threadReadFailure = (
  reason: ThreadReadDiagnostic,
  noDestinationAttempt = false,
): OrchestratorMcpFailure =>
  new OrchestratorMcpFailure({
    code: reason === "denied" ? "capability_denied" : "environment_unavailable",
    threadReadReason:
      reason === "denied"
        ? "permission_denied"
        : reason === "unsupported"
          ? "unsupported"
          : "unavailable",
    message: threadReadMessages[reason],
    ...(noDestinationAttempt ? { noDestinationAttempt: true as const } : {}),
  });

/** The selection value stays internal; only an exhausted reference route exposes this recovery. */
export const referenceReadFailure = (reason: ThreadReadDiagnostic, selection = false) => {
  const base = threadReadFailure(reason, selection);
  return new OrchestratorMcpFailure({
    code: base.code,
    threadReadReason: base.threadReadReason,
    message:
      reason in referenceReadMessages
        ? referenceReadMessages[reason as keyof typeof referenceReadMessages]
        : base.message,
    ...(selection ? { noDestinationAttempt: true as const } : {}),
  });
};

// Selection has exhausted both independent authorities; only a changed condition permits a new read.
export const exhaustedReferenceFailure = (
  cause: OrchestratorMcpFailure,
  expiredPeerEnvironmentId?: EnvironmentId,
) =>
  new OrchestratorMcpFailure({
    code: cause.code,
    ...(cause.threadReadReason === undefined ? {} : { threadReadReason: cause.threadReadReason }),
    message:
      expiredPeerEnvironmentId === undefined
        ? cause.message
        : `${cause.message} This environment's outgoing read link to ${expiredPeerEnvironmentId} has also expired, so as an alternative to the client recovery above, ask the user to renew that link; do not read again until the client's authority or connection, or that link, changes.`,
  });
