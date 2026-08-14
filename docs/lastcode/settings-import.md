# Importing T3 Code Settings

LastCode keeps its runtime profile independent from T3 Code. Settings → LastCode
offers a one-time **Import and restart** action so a new LastCode install can
start with familiar preferences without sharing mutable state between the two
applications.

The preview reads the standard T3 Code profile at `~/.t3/userdata`. It shows the
status of each supported source file before enabling the import. Missing and
invalid files are skipped; at least one valid category is required.

The import is unavailable when the Windows desktop is configured in WSL-only
mode. In that mode the active server profile lives inside WSL rather than in the
Windows LastCode profile. Normal Windows mode and parallel WSL mode import the
Windows primary profile as expected.

## Imported categories

| Category                        | Source and destination file | Imported data                                                                                                                                    |
| ------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Appearance and app preferences  | `client-settings.json`      | Theme, fonts, editor behavior, sidebar preferences, confirmations, favorites, and model display preferences                                      |
| Keyboard shortcuts              | `keybindings.json`          | Valid custom keybinding rules                                                                                                                    |
| Server and provider preferences | `settings.json`             | Background behavior, Git fetch behavior, thread defaults, source-control writing preferences, model selection, and legacy provider paths/toggles |

Only non-secret provider fields are copied. Provider launch arguments, the
OpenCode server password, and provider-instance records are excluded. Existing
LastCode values for excluded fields remain unchanged.

## Deliberate exclusions

The importer never copies:

- databases, projects, threads, checkpoints, attachments, or other workspace data;
- environment or machine identity;
- authentication tokens, provider-instance environment variables, or other secrets;
- saved environments or connection catalogs;
- desktop window state, server exposure mode, Tailscale configuration, ports,
  or WSL runtime selection;
- update channels or LastCode's local-nightly opt-in;
- logs, caches, browser state, update artifacts, or release identity.

These boundaries let T3 Code and LastCode run concurrently without either app
mutating the other's state. The import is a copy, not synchronization; later
changes in either application remain local to that application.

## Backup and failure behavior

Before replacing any LastCode file, the importer writes the previous version to
`~/.lastcode/settings-import-backups/<timestamp>-<id>/`. The backup directory is
private to the local user and includes a manifest recording which categories
were imported and which destination files previously existed.

Each replacement is written to a temporary sibling and atomically renamed. If
a later replacement fails, files already replaced in that operation are restored
to their pre-import contents. A successful import requests a normal LastCode
restart so both the desktop shell and its bundled server load the new settings.
