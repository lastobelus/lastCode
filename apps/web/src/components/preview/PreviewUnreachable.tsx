import { useState } from "react";

import { Button } from "~/components/ui/button";

import { describePreviewError } from "./errorCodeMessages";
import type { PreviewRecoveryRequestState } from "./previewRecoveryRequest";

interface Props {
  url: string;
  /** Chromium net error code, e.g. -105. */
  code: number;
  /** Stringified Chromium error, e.g. "ERR_NAME_NOT_RESOLVED". */
  description: string;
  onReload: () => void;
  recoveryRequest: PreviewRecoveryRequestState;
  restoringHostedPreview?: boolean;
  managedHandoff?: boolean;
  onRequestRecovery: () => void;
}

/** Theme-aware tailwind port of Chromium's "This site can't be reached" page. */
export function PreviewUnreachable({
  url,
  code,
  description,
  onReload,
  recoveryRequest,
  restoringHostedPreview = false,
  managedHandoff = false,
  onRequestRecovery,
}: Props) {
  const [showDetails, setShowDetails] = useState(false);
  const host = safeHost(url) ?? url;
  const friendly = describePreviewError(description);
  const errorLabel = description.length > 0 ? description : `ERR_${Math.abs(code) || "FAILED"}`;

  return (
    <div className="relative flex h-full min-h-0 w-full overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col px-8 py-12 sm:py-16">
        <ErrorIcon className="mb-6 size-12 text-muted-foreground/70" />
        <h1 className="mb-3 text-2xl font-semibold leading-tight text-foreground">
          This site can&rsquo;t be reached
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          <span className="font-semibold text-foreground">{host}</span>: {friendly}.
        </p>

        {showDetails ? (
          <div className="mt-6 rounded-lg border border-border bg-muted/40 p-4 text-sm">
            <p className="mb-2 font-medium text-foreground">Try:</p>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              <li>Checking your connection</li>
              <li>Confirming the dev server is running</li>
              <li>Checking the proxy and the firewall</li>
            </ul>
          </div>
        ) : null}

        <div className="mt-8 text-xs uppercase tracking-wide text-muted-foreground/70">
          {errorLabel}
        </div>

        <div className="mt-6 flex flex-col items-start gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={
              restoringHostedPreview ||
              (!managedHandoff &&
                (recoveryRequest.status === "sending" || recoveryRequest.status === "sent"))
            }
            onClick={managedHandoff ? onReload : onRequestRecovery}
          >
            {restoringHostedPreview
              ? "Restoring preview…"
              : managedHandoff
                ? "Retry preview"
                : recoveryRequest.status === "sending"
                  ? "Sending request…"
                  : recoveryRequest.status === "sent"
                    ? "Request sent"
                    : "Ask agent to restore preview"}
          </Button>
          <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
            {restoringHostedPreview
              ? "LastCode is reopening this preview."
              : managedHandoff
                ? "This saved preview reopens automatically. Retry when its environment is available."
                : recoveryRequest.status === "sent"
                  ? "The failed link and error were sent to this thread. Reload after the agent restores it."
                  : recoveryRequest.status === "error"
                    ? recoveryRequest.error
                    : "Send this failed link and error to the agent in this thread."}
          </p>
        </div>

        <div className="mt-auto flex items-center gap-2 pt-8">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setShowDetails((value) => !value)}
          >
            {showDetails ? "Hide details" : "Details"}
          </Button>
          <div className="flex-1" />
          <Button type="button" size="sm" onClick={onReload}>
            Reload
          </Button>
        </div>
      </div>
    </div>
  );
}

function ErrorIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      className={className}
    >
      <path d="M16 12 L48 12 L48 52 L16 52 Z" />
      <path d="M22 22 L42 22 M22 30 L36 30 M22 38 L40 38" strokeLinecap="round" />
      <path d="M52 8 L12 56" strokeLinecap="round" />
    </svg>
  );
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
