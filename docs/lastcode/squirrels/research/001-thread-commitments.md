# Keeping thread commitments through distractions and compaction

You should be able to hand a concern to a thread without becoming responsible for reminding it forever. **My recommendation is a durable thread commitment list, backed by a whole-thread audit skill.** Keep the existing checklist for immediate work, but stop relying on it to remember everything.

Two subagents investigated current guidance and LastCode’s implementation. Code findings describe this checkout; I did not inspect the running app or change product code.

**1. The checklist you see is real—but it is not a complete thread task manager.**

- Providers emit checklist updates, which LastCode saves in thread activity history.
- LastCode can find an older checklist, but the composer only displays tasks belonging to the current, unfinished turn. An unfinished list can therefore disappear when the turn ends or another turn starts. See [the display condition](../../../../apps/web/src/components/ChatView.tsx:5009) and [older-list selection](../../../../apps/web/src/session-logic.ts:656).
- The drawer is display-only: you cannot currently edit or annotate its items there.
- We found no LastCode mechanism that reintroduces the saved checklist into subsequent provider requests. Its survival in storage does not guarantee the agent remembers it after steering or compaction.

Plan Mode documents are a separate saved artifact that can be handed to an implementation turn. Neither mechanism automatically accounts for every request, question, or promise throughout a conversation.

**2. Better guidance helps, but durable state is the foundation.**

Current official guidance supports keeping structured notes outside the context window and reloading them during long-running work. Anthropic specifically describes compaction’s potential to lose important details, and uses progress records plus verification before declaring work complete. [Context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), [long-running agent harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents).

OpenAI documents compaction as compressed, opaque continuation state. That is useful for continuity, but it is not a user-inspectable register of outstanding commitments. Skills provide repeatable workflows; persistent guidance provides behavioral rules. Neither alone guarantees exhaustive recall. [Compaction](https://developers.openai.com/api/docs/guides/compaction), [customization](https://learn.chatgpt.com/docs/customization/overview).

**3. Give each thread a persistent “Commitments” list.**

This is a proposed feature, not something already available. It should include original goals, later requests, unresolved questions, and parked squirrels—with a link to the message that introduced each one.

| Keep track of | Why it matters |
|---|---|
| Stable identity and source message | An item cannot disappear just because a checklist was rewritten. |
| State: open, working, blocked, parked, done, dropped | A distraction or blocker does not imply completion. |
| Whether action is authorized | Mentioning an idea records it without automatically launching work. |
| Completion evidence or explicit cancellation | The agent must account for how a commitment ended. |
| Notes, dependencies, and handoff destination | Deferred or delegated work remains traceable. |

You should be able to add, edit, annotate, park, reopen, and explicitly drop items. The list should remain available between turns. Provider checklist updates can suggest progress, but replacing a checklist must never delete commitments silently.

LastCode should supply outstanding commitments to the agent at turn start and after context recovery, with a defined refresh path for mid-turn steering. A short rule should require reconciliation before the agent reports completion. This reduces dependence on memory; it still needs testing because an agent can misinterpret a request or overclaim completion.

**4. Build one audit engine with two ways to ask.**

- **“What’s next?”** checks the commitment list and messages since the last audit, then recommends the next authorized action while keeping parked work and blockers visible.
- **“Anything left for this thread?”** reconciles the entire conversation from its beginning against completion evidence, cancellations, and handoffs. It reports unfinished work, unanswered questions, parked ideas, and decisions needed.

For long threads, subagents can inspect separate history segments and return candidate obligations with message references. The primary agent must reconcile them chronologically: a later message may complete, change, or cancel an earlier request. Chunk summaries alone are not enough.

There is a concrete access limitation to address first: the current thread-reading command defaults to five recent turns, allows at most twenty, and bounds output to 64,000 characters. It also omits detailed activity payloads. A skill using only that command could miss the original goals. The server already supports older-history pagination, so a complete-history reader is feasible. See [reader limits](../../../../apps/server/src/cli/thread.ts:52) and [pagination contract](../../../../packages/contracts/src/orchestration.ts:1002).

The audit must report its coverage. If history is missing or truncated, it should say “I could not verify the whole thread,” never “nothing left.” A quick audit should become a full audit whenever its saved coverage is missing or uncertain.

**5. Start small, then make it reliable.**

I would implement complete-history access and the audit skill first, using a persistent per-thread record outside the repository. That lets us recover neglected work in existing threads. Then add the editable LastCode list and automatic context refresh. Simply keeping the existing drawer visible would be useful, but would solve only visibility.

The short guidance rule I would pair with that workflow is:

> Treat new messages as additions or steering unless I explicitly replace or cancel earlier work. Preserve original goals, later requests, unresolved questions, and parked ideas in the thread’s persistent commitment record. Recording an idea does not authorize executing it. Before answering “what’s next?” reconcile outstanding commitments; before answering “anything left for this thread?” audit the whole conversation. Require evidence for completion, preserve explicit cancellations and handoffs, and disclose incomplete history coverage.

The acceptance test should reproduce your experience: start with A/B/C, chase D, ask about A, compact, then ask “anything left?” B/C/D must still be accounted for, including anything parked or awaiting permission.

**The aim is to let you put things down safely.** The next concrete step is the complete-history reader plus audit workflow; the persistent LastCode list makes that accountability visible and editable. No skills, guidance, or application behavior were changed during this research.
