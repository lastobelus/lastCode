# Upstream alignment review for October 2026

This review compares upstream changes since October 9 with LastCode release
`0.1.3-nightly.20261025.3655`. It collects the architectural recommendations,
replacement decisions, and validation plan for that release. Findings and test
results are in progress; this draft does not establish release acceptance.

## Source boundaries

- Previous upstream analysis: `a1db449fe4fecafcb473340771163e791b7fb3d6`.
- Upstream comparison tip: `557db6cb4eb7ebe5d9b1300ecce8e05f1929fc39`.
- LastCode release source: `c909106a31be7aa452a31fce86bd32d47716fadb`, tagged
  `lastcode/checkpoint/v0.1.3-nightly.20261025.3655`.
- Shared upstream base: `e9d61252f6fd8369b80fe8f7e07209cbbb7221d9`.

The release source and newer upstream tip are separate comparison points.
Commit inclusion, package publication, installation, and observed runtime
behavior require separate evidence. Compiled carry groups and their historical
contribution records are not counts of newly developed features.

## Analysis and recommendation plan

Luna discovery inventories upstream changes and the current downstream delta.
Sol analysis turns that evidence into architectural recommendations and a
keep, adapt, replace, or retire decision for each affected LastCode feature.
Astra High and Opus 5.5 High independently review the findings and plan. Opus
then rewrites the recommendations for maintainer decisions.

The architecture review covers provider and source-control service boundaries,
orchestration and committed event delivery, persistence concurrency, MCP
registration and permissions, remote and browser ownership, client state and
history transport, settings, and migrations. Each recommendation must identify
the concrete constraint, relevant source, affected clients and providers,
benefit, implementation risk, prerequisites, and acceptance evidence.

The overlap review checks actual net source differences. An upstream feature
replaces local work only when its behavior covers the local requirement.
Adjacent features and renamed services are insufficient proof. Existing
regression tests remain valuable after an implementation is absorbed upstream;
historical provenance alone is not an active duplicate implementation.

## Validation plan

Automate deterministic behavior before requesting human judgement. Use focused
test batches and existing exact-revision CI evidence. Add tests for demonstrated
coverage gaps; do not run a repository-wide suite solely for this review.

The first risk areas are real MCP registration and invocation, restricted
credentials and destination authorization, Pause across automatic wake paths,
Action completion and recovery, native PR-watch delivery, cross-environment
thread reads, archive and recovery behavior, retained browser handoffs, and
dependency cleanup protections. Architectural findings may add targeted cases
with a stated reason.

For each check, record its source revision, command or interaction, expected
behavior, result, and evidence. Separate passed, failed, blocked, and pending
human acceptance. A setup failure does not establish a product regression.
Event-driven tests await committed events or drain effect workers rather than
using delays as proof.

One primary-owned isolated development preview will contain the visual QA
fixtures. Automated browser interaction prepares the exact route and state for
each human check. The maintainer receives a short checklist with what to look
for, how to report a failure, and a direct entry to the prepared scenario.
Native-only or remote-only behavior must be identified explicitly rather than
claimed from a web preview.

Human review starts only after the relevant change exists in a reviewed PR
with clean CI. Existing browser and server ownership remains intact. The
preview is retained while acceptance is outstanding.

## Defect and repair delivery

File a public issue as soon as a reproducible product defect is confirmed,
after checking for an existing equivalent issue. Describe generic reproduction,
expected and actual behavior, affected source, and focused evidence. Keep
private operational details outside the public repository.

Independent fixes use separate PRs with focused validation and independent
review. The parent coordinates their delivery and native PR watches. Merge
only after the repository's current-head review and CI gates pass. Changes
requiring maintainer judgement remain ready for inspection rather than being
merged on an assumed acceptance. The analysis PR collects recommendations;
it does not combine unrelated production repairs.

## Completion evidence

The completed review will contain the upstream inventory summary, architectural
recommendations, the replacement matrix, automated results, issue and repair PR
links, and a short list of remaining maintainer decisions or visual checks.
Each blocked item must state the specific prerequisite that would unblock it.
