export function projectsContainPersistentThread(input: {
  members: ReadonlyArray<{ readonly environmentId: string; readonly id: string }>;
  threads: ReadonlyArray<{
    readonly environmentId: string;
    readonly projectId: string;
    readonly persistent?: boolean | undefined;
  }>;
}): boolean {
  const projectKeys = new Set(
    input.members.map((member) => `${member.environmentId}:${member.id}`),
  );
  return input.threads.some(
    (thread) =>
      thread.persistent === true && projectKeys.has(`${thread.environmentId}:${thread.projectId}`),
  );
}
