import type {
  DesktopBridge,
  DesktopUpdateReleaseNote,
  DesktopUpdateState,
} from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";

import { APP_BASE_NAME } from "../../branding";
import {
  type DesktopUpdatePopoverHeader,
  getDesktopUpdatePopoverHeader,
  getDesktopUpdateReleaseHistoryUrl,
  getDesktopUpdateReleaseNoteUrl,
} from "../desktopUpdate.logic";
import { useRelativeTimeState } from "../../hooks/useRelativeTimeState";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { openDesktopUpdateReleaseNotes } from "../desktopUpdate.toast";

type DesktopUpdateShell = Pick<DesktopBridge, "openExternal">;

function keyReleaseNoteItems(items: ReadonlyArray<string>) {
  const occurrences = new Map<string, number>();
  return items.map((item) => {
    const occurrence = occurrences.get(item) ?? 0;
    occurrences.set(item, occurrence + 1);
    return { item, key: JSON.stringify([item, occurrence]) };
  });
}

/** Feed times read "3h ago"; build days from a prerelease version read "today" or "2d ago". */
function formatReleaseAge(releasedAt: string): string {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(releasedAt);
  if (!day) return formatRelativeTimeLabel(releasedAt);
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = Math.round(
    (today - Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]))) / 86_400_000,
  );
  return days <= 0 ? "today" : `${days}d ago`;
}

export function resolveReleaseNoteHeading(
  releaseNote: DesktopUpdateReleaseNote,
  index: number,
): string {
  return (
    releaseNote.heading ?? (index === 0 ? "What's changed" : `Changes in ${releaseNote.version}`)
  );
}

export function keyReleaseNoteGroups(releaseNotes: ReadonlyArray<DesktopUpdateReleaseNote>) {
  const occurrences = new Map<string, number>();
  return releaseNotes.map((releaseNote) => {
    const identity = JSON.stringify([releaseNote.version, releaseNote.heading ?? null]);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return { releaseNote, key: JSON.stringify([identity, occurrence]) };
  });
}

function ReleaseLink({
  children,
  releaseUrl,
  shell,
}: {
  readonly children: string;
  readonly releaseUrl: string;
  readonly shell: DesktopUpdateShell | undefined;
}) {
  return (
    <a
      className="mt-1 inline-flex items-center gap-1 rounded-sm text-xs leading-5 text-muted-foreground underline-offset-2 outline-none transition-colors hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      href={releaseUrl}
      onClick={(event) => {
        event.preventDefault();
        void openDesktopUpdateReleaseNotes(shell, releaseUrl);
      }}
    >
      {children}
      <ExternalLinkIcon aria-hidden className="size-3 shrink-0" strokeWidth={2} />
    </a>
  );
}

/** When this offer was last confirmed, and why a later refresh failed while it stayed usable. */
export function SidebarUpdateFreshness({ state }: { readonly state: DesktopUpdateState }) {
  const checked = useRelativeTimeState(state.checkSucceededAt ?? null);
  return (
    <>
      {checked.status === "relative" ? (
        <div className="mt-0.5 text-2xs leading-4 text-muted-foreground">
          {`Checked ${checked.suffix ? `${checked.value} ${checked.suffix}` : checked.value}`}
        </div>
      ) : null}
      {state.refreshFailure ? (
        <div className="mt-0.5 max-h-16 overflow-y-auto break-words text-2xs leading-4 text-warning">
          Latest check failed: {state.refreshFailure}
        </div>
      ) : null}
    </>
  );
}

/** The app's target, readiness, and the run's other updates; shared by every update popover. */
function SidebarUpdateHeader({
  alsoUpdates,
  header,
  releasedAt,
  state,
}: {
  readonly alsoUpdates: string | null;
  readonly header: DesktopUpdatePopoverHeader;
  readonly releasedAt?: string | undefined;
  readonly state: DesktopUpdateState;
}) {
  // A shortened title still needs the full version; a full one only needs the release age.
  const fullVersionInTitle = header.title.endsWith(header.targetVersion);
  const age = releasedAt ? formatReleaseAge(releasedAt) : null;
  const versionDetail = fullVersionInTitle
    ? age && `Released ${age}`
    : age
      ? `${header.targetVersion} · ${age}`
      : header.targetVersion;
  return (
    <div>
      <div className="break-words text-sm leading-5 font-medium">{header.title}</div>
      <div className="mt-0.5 text-xs leading-4 text-muted-foreground">{header.readiness}</div>
      {versionDetail ? (
        <div className="mt-0.5 break-words text-2xs leading-4 text-muted-foreground">
          {versionDetail}
        </div>
      ) : null}
      <SidebarUpdateFreshness state={state} />
      {alsoUpdates ? (
        <div className="mt-1.5 text-xs leading-4 text-muted-foreground">Also: {alsoUpdates}</div>
      ) : null}
    </div>
  );
}

export function SidebarUpdateReleaseNotes({
  alsoUpdates = null,
  shell,
  state,
  tooltip,
}: {
  readonly alsoUpdates?: string | null;
  readonly shell: DesktopUpdateShell | undefined;
  readonly state: DesktopUpdateState;
  readonly tooltip: string;
}) {
  const header = getDesktopUpdatePopoverHeader(state, APP_BASE_NAME);
  if (state.releaseNotes.length === 0 && !header) {
    return <>{tooltip}</>;
  }
  const releasedAt = header
    ? state.releaseNotes.find((releaseNote) => releaseNote.version === header.targetVersion)
        ?.releasedAt
    : undefined;

  return (
    <div className="flex max-h-[calc(var(--available-height)-0.5rem)] min-h-0 w-fit max-w-[min(24rem,calc(100vw-2rem))] flex-col text-left text-pretty">
      <div className="shrink-0 px-1">
        {header ? (
          <SidebarUpdateHeader
            alsoUpdates={alsoUpdates}
            header={header}
            releasedAt={releasedAt}
            state={state}
          />
        ) : (
          <div className="text-sm leading-5 font-medium">{tooltip}</div>
        )}
      </div>
      {state.releaseNotes.length > 0 ? (
        <div className="min-h-0 max-h-[min(28rem,calc(100vh-6rem))] overflow-y-auto px-1 pt-3 pb-1">
          {keyReleaseNoteGroups(state.releaseNotes).map(({ releaseNote, key }, index) => {
            const releaseUrl = getDesktopUpdateReleaseNoteUrl(releaseNote);
            const omittedItemCount = Math.max(0, releaseNote.totalItems - releaseNote.items.length);
            const linkLabel =
              releaseNote.stats ??
              (omittedItemCount === 0
                ? "View release on GitHub"
                : `${omittedItemCount} more ${omittedItemCount === 1 ? "change" : "changes"} on GitHub`);

            const generated = releaseNote.stats !== undefined || releaseNote.intro !== undefined;
            return (
              <section className={index > 0 ? "mt-4" : undefined} key={key}>
                {generated ? (
                  releaseNote.version !== state.availableVersion && (
                    <h3 className="mb-1 text-xs leading-4 font-medium text-muted-foreground">
                      {releaseNote.releasedAt
                        ? `${releaseNote.version} · ${formatReleaseAge(releaseNote.releasedAt)}`
                        : releaseNote.version}
                    </h3>
                  )
                ) : (
                  <h3 className="mb-2 text-foreground text-xs leading-4 font-semibold">
                    {resolveReleaseNoteHeading(releaseNote, index)}
                  </h3>
                )}
                {releaseNote.intro ? (
                  <p className="break-words text-xs leading-5 text-popover-foreground">
                    {releaseNote.intro}
                  </p>
                ) : releaseNote.items.length > 0 ? (
                  <ul className="space-y-1.5 pl-4 text-xs leading-5 text-popover-foreground/90">
                    {keyReleaseNoteItems(releaseNote.items).map(({ item, key }) => {
                      const highlight = /^\*\*([^*]+)\*\* (.+)$/.exec(item);
                      return (
                        <li className="list-disc break-words" key={key}>
                          {highlight ? (
                            <>
                              <strong>{highlight[1]}</strong> {highlight[2]}
                            </>
                          ) : (
                            item
                          )}
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
                {releaseNote.summaries && releaseNote.summaries.length > 0 ? (
                  <div className="mt-2 space-y-1 text-xs leading-5 text-popover-foreground/70">
                    {keyReleaseNoteItems(releaseNote.summaries).map(
                      ({ item: summary, key: summaryKey }) => (
                        <p className="break-words" key={summaryKey}>
                          {summary}
                        </p>
                      ),
                    )}
                  </div>
                ) : null}
                {releaseNote.footer && (
                  <p className="mt-2 text-xs leading-5 font-semibold">{releaseNote.footer}</p>
                )}
                {releaseUrl && (
                  <ReleaseLink releaseUrl={releaseUrl} shell={shell}>
                    {linkLabel}
                  </ReleaseLink>
                )}
              </section>
            );
          })}
          {state.omittedReleaseCount > 0 ? (
            <div className="mt-3">
              <ReleaseLink releaseUrl={getDesktopUpdateReleaseHistoryUrl()} shell={shell}>
                {`${state.omittedReleaseCount} older ${state.omittedReleaseCount === 1 ? "release" : "releases"} on GitHub`}
              </ReleaseLink>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
