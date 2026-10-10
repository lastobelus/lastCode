---
name: report
description: Prepare user-facing reports for opted-in persistent maintenance and automation coordinators, or clarify a previous report when the user says "report skill", "retry with report skill", "wut", "what?", "what now?", or "uhh...". Also use for complaints about unclear wording, requests for plain English or ELI5, and questions about what a passage actually means. Ordinary PR and implementation work keeps its existing reporting rules unless the user requests this clarification.
---

# Report

Use this skill when explicitly requested in ordinary language, when the user signals that agent prose is unclear, or when an opted-in persistent maintenance or automation coordinator needs to report to the user. A prompt or CLI-delivered message may reference `report` directly. Read this file anew when invoked after a resumed turn or compaction; conversation summaries are not the authoritative instructions.

Treat "wut", "what?", "what now?", "uhh...", "wtf", "say again?", "plain English", "better language", "ELI5", and "what does that actually mean?" as clarification signals when they refer to agent prose. An ordinary factual question containing "what" does not by itself activate this skill. An explicit clarification can apply in any thread; automatic coordinator reporting remains scoped to opted-in persistent maintenance and automation work.

## Write for someone returning from other work

Assume the user is returning after working in 5–20 other threads and does not remember this conversation. You retain the context; each material report must restore the context needed to understand it.

- Identify the requested work, its outcome, and why this update matters now. Name the relevant conversation when its title is available; phrases such as "this conversation" still leave the returning reader to recover its identity.
- Name specific threads, tools, systems, and artifacts, and explain their relevance. "The CLI" needs its name and, when relevant, its host. "The original fix thread" needs its title and why it is involved.
- For LastCode threads, use the ready-to-paste Markdown link returned by `t3_thread_list` or `t3_thread_read` when available. Preserve the returned URL; never construct or guess one. When a usable link is unavailable, including an unsupported cross-environment reference, delimit the thread title with bold italic (`***Thread title***`) instead of quotation marks.
- Report what happened to the user's task before describing the tool symptom. "I couldn't notify the thread that requested the build" explains the consequence; "no verified thread link could be retrieved" leaves the user to infer it.
- Technical vocabulary is welcome when useful. Familiar words also need clear referents. Preserve names, reasons, and consequences when shortening a report.
- Separate secondary failures from the requested outcome: a successful build with a failed notification is a successful build. Mention unchanged deferrals and settled permissions again only when they affect a current decision. Keep required acceptance evidence recorded.

Before sending, check: Can someone returning from unrelated work tell which task and entities this concerns, why each detail matters, and whether anything needs their action?

## Make the result easy to scan

Answer the user's question or state the task's outcome in the opening sentence. Use short paragraphs with one main point each. Use a list for parallel concrete examples, and selective bold for a consequential fact or named next step. Preserve the names, reasons, and consequences that restore context; do not add labels or emphasis to every sentence.

## Retry the report

When the user asks for a retry or clarification, identify the exact passage they mean, including an older message, quotation, or linked report. Use its task context and verified facts; if the source cannot be checked, say what is unavailable rather than guessing. Correct unclear references and state the practical consequence. Do not repeat the underlying build, repair, notification, or other operation just to rewrite its report. If a needed name or fact is absent, say what is unknown without inventing it.

Preserve wording the user explicitly preferred unless they ask to change it. Keep concrete examples concrete and preserve their scope: a feature of one document is not a rule for every document. Explain the examples when needed instead of replacing them with new abstractions.

## Coordinator reports

Keep healthy or unchanged automated wakes quiet when the coordinator's operating policy requires silence. An explicit user request for a report still deserves an answer. A short-report limit must preserve enough context to identify the work and understand its result; omit routine bookkeeping first.

Keep machine coordination packets in their required format. This skill governs prose addressed to the user, not protocol schemas. It adds no operational permissions and does not change the task's acceptance requirements.
