# Remote Update Activation Helper

LastCode contains a dormant, scripts-only transaction helper for replacing one
Intel host's application and packaged-server LaunchAgent without making a
half-installed selection durable. Nothing invokes or installs this helper yet.

The helper intentionally supports one deployment shape: the active server is
owned by `codes.lastobelus.lastcode.server`, the LastCode desktop app is not
running, and that LaunchAgent holds the canonical server-owner lease. It rejects
a desktop-owned environment, simultaneous desktop and LaunchAgent presence, an
unknown lease holder, or no active owner before stopping anything.

## Transaction boundary

Preparation receives one trusted request ID and the SHA-256 digest of an
already-validated target. Candidate app and plist paths, live paths, database
paths, backups, the commit record, and the journal are derived from the home
directory and request ID. The candidate plist must name the packaged service
and carry exact trial-mode, request-ID, and target-digest environment values.

The external journal has five coarse states: `prepared`, `backup-ready`,
`trial`, `committed`, and `rolled-back`. Activation stops the LaunchAgent,
acquires the now-free owner lease, snapshots `state.sqlite` plus existing WAL
and SHM sidecars, and publishes a completion sentinel. It then renames the old
app and plist aside, installs the candidate selection, releases the lease, and
starts the candidate in trial mode.

The candidate commits only by atomically publishing `commit.json` with exactly
the prepared request ID and target digest. A bounded timeout, mismatched record,
ordinary activation failure, or uncertain helper restart restores the database,
app, and plist before restarting the prior service. If the exact commit record
survives a helper crash, recovery finishes forward instead. Terminal retries
are idempotent.

This intentionally omits dual service-label migration, disabled-override
restoration, orphan scans, application-tree identities, helper self-hashing,
and broad hostile-local filesystem hardening. Production wiring must first add
the server-side trial/commit producer and a detached invocation path; until
then, the helper remains unreachable.
