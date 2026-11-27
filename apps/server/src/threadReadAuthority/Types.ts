import type { MessageId, ThreadId } from "@t3tools/contracts";

/** Private server authority. Never serialize into events or transport arguments. */
export interface SessionAuthority {
  readonly sessionId: string;
  readonly proofKey: string | null;
  readonly subject: string;
  readonly method: string;
  readonly scopes: ReadonlyArray<string>;
  readonly familyId: string;
  readonly keyGeneration: number | null;
  readonly familyGeneration: number;
  readonly liveLease?: () => boolean;
  readonly inheritedGrant?: {
    readonly threadId: ThreadId;
    readonly kind: "run" | "reference";
    readonly grantId: string;
    readonly lastUsedAt: number;
  };
  readonly liveSessionIds?: () => ReadonlyArray<string>;
}

/** The registered socket ID, not a renewed SessionStore head, supplies the live lease. */
export interface AuthorityLease {
  readonly connectedSessionIds?: ReadonlyArray<string>;
  readonly now?: number;
  readonly isLive?: () => boolean;
}

export type AuthorityFailureReason =
  | "reauth-required"
  | "revoked"
  | "expired"
  | "fence-unavailable";
export type ThreadReadIntakeIntent = {
  readonly threadId: ThreadId;
  readonly inputId: MessageId;
} & (
  | { readonly authority: SessionAuthority; readonly denialReason?: never }
  | { readonly denialReason: AuthorityFailureReason; readonly authority?: never }
);

export interface ThreadReadGrant extends SessionAuthority {
  readonly threadId: ThreadId;
  readonly kind: "run" | "reference";
  readonly grantId: string;
  readonly lastUsedAt: number;
}

export type GrantCheck =
  | { readonly status: "eligible"; readonly sessionIds: ReadonlyArray<string> }
  | {
      readonly status:
        | "disconnected"
        | "revoked"
        | "expired"
        | "fence-unavailable"
        | "reauth-required";
    };
