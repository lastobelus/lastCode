# LastCode charters

A charter records what the owner intends for one feature area of LastCode, so carry decisions follow that intent instead of guessing.

## Tiers

- **defend**: our version is the product. Keep it even when upstream builds something similar. Reconcile toward upstream only when the owner decides to.
- **prefer ours**: keep our version unless intent tests show that upstream covers every intent in the charter. Then reconcile toward upstream and retire ours.
- **yield**: move to upstream's approach as soon as it covers the intent, and retire ours.

An area without a charter follows the default, **lean upstream**: retire or reconcile when upstream covers the behaviour.

## How areas are drawn

Areas are features as a user sees them, not directories. One feature touches many directories, and one directory serves many features. Every level of the hierarchy has 3–7 nodes.

Each top-level area gets one charter file, `<area-id>.md`, with its sub-features as sections. A sub-feature gets its own charter only when it needs a different tier from its parent, for example to separate the parts that must work our way from the parts where upstream's way is good enough.

A charter's `paths` are the main code paths behind the feature. They are hints and may overlap. When a carry touches several areas, the strictest tier applies: defend, then prefer ours, then yield.

## Areas

A tier of `—` means the area has no charter yet and follows lean upstream.

| Area                                                   | Tier        | Sub-features                                                                                                                                     |
| ------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent-orchestration`: Agents directing agents         | prefer ours | Delegated tasks and child threads · Thread tools for agents · Waiting without polling · Scheduled tasks · PR and issue follow-through            |
| `thread-organization`: Keeping many threads manageable | —           | Sidebar families and conveniences · Pin, snooze and settle · Thread annotations · Archiving thread families                                      |
| `seeing-the-work`: Seeing what agents build            | prefer ours | Background browser for agent QA · Preview hosting and handoff links · Browser profiles, import and annotations · Simulator and emulator devices  |
| `machines-and-checkouts`: Machines and worktrees       | prefer ours | Linked environments · Pausing and resuming an environment · Worktree lifecycle (suspend, hand off, restore) · Storage cleanup · Machine capacity |
| `in-a-thread`: Working inside a thread                 | prefer ours | Composer and prompt snippets · Keyboard scrolling and focus · Terminal · Provider adjustments                                                    |
| `running-lastcode`: Running my own LastCode            | yield       | Local nightly updates and install · Checkpoints and carry replay · Local CI and PR gates · Setup and settings import · Appearance and branding   |
