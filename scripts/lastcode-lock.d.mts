export const LOCK_MODULE_MANAGED_MARKER: string;
export const DARWIN_O_EXLOCK: number;

export function acquirePortableLock(
  lockDirectory: string,
  lockName: string,
  activity: string,
): () => void;
