# Glossary

> For LastCode contributors and operators. Using T3 Code? See [docs/user](../user/).

This is a living glossary for LastCode. It explains what fork-maintenance terms mean in this
codebase and names the preferred language for new documentation.

## Table of contents

- [Fork maintenance](#fork-maintenance)

## Concepts

### Fork maintenance

Fork maintenance keeps LastCode's intentional downstream changes working as T3 Code moves
forward. See [the nightly workflow][1] for the current replay and publication process and
[the fork conventions][2] for contribution boundaries.

#### Downstream carry set

The complete, ordered set of LastCode-owned changes retained across upstream updates. It is the
delta LastCode intentionally carries on top of an upstream T3 Code version, not the upstream code
underneath it and not the pull requests that originally delivered it.

Today, `lastcode/main` represents the downstream carry set as replayable commit history. The initial
carry-set tooling inventories that history into stable groups and proves it can reconstruct the same
final tree as a bounded sequence of generated commits. It does not yet replace the nightly replay or
publish the generated history.

#### Patch stack

The general Git term for an ordered series of patches applied on top of another codebase. In
LastCode documentation, prefer [downstream carry set](#downstream-carry-set) when referring to the
complete set of changes the fork retains across upstream updates. This distinguishes the durable
fork delta from stacked pull requests and other temporary development branches.

#### Carry patch

One bounded change unit inside a [downstream carry set](#downstream-carry-set). A carry patch should
describe the final change LastCode needs to retain, rather than preserving every development commit
that produced it. Boundaries should follow coherent ownership and maintenance: a later fix belongs
in the carry patch it repairs, while a separately owned capability belongs in another carry patch.

Carry patches do not have to apply independently. The downstream carry set declares one fixed
application order, and a later carry patch may depend on an earlier one. For example, an initial
order can apply `Upstream bugfixes`, `Tooling`, `Resumable Actions`, `Legacy Sidebar`, and then
`Incubator`. Resumable Actions carries its essential behavior without the legacy sidebar; Legacy
Sidebar owns the optional resumable-action visibility and applies after the capability it presents.

#### Upstream bugfixes

The carry patch for fixes that also have an upstream lifecycle. Its contents are either imports of
existing upstream pull requests or LastCode copies of fixes also proposed upstream. Keep it closest
to the upstream base and retain the corresponding upstream PR provenance for each fix.

This patch is expected to change more often than fork-only feature patches. When upstream merges,
partially replaces, or solves a fix differently, reconcile or remove the corresponding downstream
change instead of carrying it permanently.

#### Incubator

The final catch-all carry patch for LastCode changes that do not yet have enough shared ownership or
weight to justify another named group. The Incubator patch is a deliberate starting bucket, not a
claim that its contents form one feature.

The group itself may remain in the fixed application order, while coherent clusters of changes
graduate from it into named carry patches as they become substantial enough to maintain separately.
The initial reconstruction also assigns files touched by more than one group to Incubator, making
mixed boundaries explicit until a later extraction can separate them safely.

## Practical Shortcuts

- If you see `downstream carry set`, think "everything LastCode intentionally keeps on top of T3
  Code".
- If you see `patch stack` in a LastCode context, think
  [downstream carry set](#downstream-carry-set).
- If you see `carry patch`, think "one maintainable, explicitly related unit within the downstream
  carry set".
- If you see `Upstream bugfixes`, think "temporary downstream copies with upstream PR provenance".
- If you see `Incubator`, think "the catch-all whose mature clusters graduate into named patches".

## Related Docs

- [LastCode documentation][3]
- [Nightly workflow][1]
- [Contribution and fork conventions][2]
- [Downstream carry set proposal ELI5][4]

[1]: ./nightly-workflow.md
[2]: ./fork-conventions.md
[3]: ./README.md
[4]: ../../doc/design/2026-08-29__downstream-carry-set-eli5.html
