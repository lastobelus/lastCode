export const NATIVE_BROWSER_IDLE_MS = 24 * 60 * 60 * 1000;
export const NATIVE_BROWSER_PAGE_LIMIT = 32;

/** Canonical tabs outlive their Chromium guests. Only demand admits a guest to this cache. */
export function createNativeBrowserLifetime(input: {
  readonly changed: (mounted: ReadonlySet<string>) => void;
  readonly now?: () => number;
  readonly idleMs?: number;
  readonly capacity?: number;
  readonly schedule: (delayMs: number, task: () => void) => () => void;
}) {
  const now = input.now ?? Date.now;
  const idleMs = input.idleMs ?? NATIVE_BROWSER_IDLE_MS;
  const capacity = input.capacity ?? NATIVE_BROWSER_PAGE_LIMIT;
  const mounted = new Map<string, { active: boolean; idleSince: number }>();
  let cancelTimer: (() => void) | undefined;
  let disposed = false;
  const publish = () => input.changed(new Set(mounted.keys()));
  const reserve = (id: string) => {
    if (mounted.has(id)) return true;
    while (mounted.size >= capacity) {
      const victim = [...mounted]
        .filter(([, entry]) => !entry.active)
        .sort((left, right) => left[1].idleSince - right[1].idleSince)[0];
      if (!victim) return false;
      mounted.delete(victim[0]);
      publish();
    }
    mounted.set(id, { active: true, idleSince: now() });
    publish();
    return true;
  };
  const sweep = () => {
    cancelTimer?.();
    cancelTimer = undefined;
    let changed = false;
    const inactive = [...mounted].filter(([, entry]) => !entry.active);
    inactive.sort((left, right) => left[1].idleSince - right[1].idleSince);
    for (const [id, entry] of inactive) {
      if (now() - entry.idleSince >= idleMs || mounted.size > capacity) {
        mounted.delete(id);
        changed = true;
      }
    }
    if (changed) publish();
    const next = [...mounted.values()]
      .filter((entry) => !entry.active)
      .reduce((expiry, entry) => Math.min(expiry, entry.idleSince + idleMs), Infinity);
    if (Number.isFinite(next)) cancelTimer = input.schedule(Math.max(1, next - now()), sweep);
  };
  return {
    reserve,
    update: (sessionIds: ReadonlySet<string>, demanded: ReadonlySet<string>) => {
      if (disposed) return;
      let changed = false;
      for (const id of mounted.keys()) {
        if (!sessionIds.has(id)) {
          mounted.delete(id);
          changed = true;
        }
      }
      for (const [id, current] of mounted) {
        const active = demanded.has(id);
        if (current.active !== active) {
          current.active = active;
          current.idleSince = now();
        }
      }
      for (const id of sessionIds) if (!mounted.has(id) && demanded.has(id)) reserve(id);
      if (changed) publish();
      sweep();
    },
    dispose: () => {
      disposed = true;
      cancelTimer?.();
    },
  };
}
