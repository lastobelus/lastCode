import type { ProjectRegistration, ThreadOwner } from "@t3tools/contracts";

export function projectRegistrationView(registration: ProjectRegistration | null | undefined) {
  return registration == null ? {} : registration;
}

export function planKeepProject(
  keepTemporary: true | undefined,
  registration: ProjectRegistration | null | undefined,
) {
  return keepTemporary === true && registration?.temporary === true
    ? { registration: { owner: registration.owner } }
    : {};
}

export function temporaryProjectsOwnedBy<
  Row extends { readonly registration?: ProjectRegistration | null | undefined },
>(rows: ReadonlyArray<Row>, owner: ThreadOwner): ReadonlyArray<Row> {
  return rows.filter(
    ({ registration }) =>
      registration?.temporary === true &&
      registration.owner.threadId === owner.threadId &&
      registration.owner.environmentId === owner.environmentId,
  );
}
