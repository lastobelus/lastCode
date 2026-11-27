# Message timestamps in agent context

**Decision: defer implementation.** The goal is to let an agent answer how old the previous message is from its conversation context. A local hook did that in LastCode with Codex and Claude Code. Claude reused the prior conversation in every matched trial. Codex preserved the request prefix in a local capture, but the live cache results varied enough that a smaller usage penalty remains possible.

## Upstream context

The closest upstream proposal is [T3 Code discussion #39416](https://redirect.github.com/pingdotgg/t3code/discussions/39416). It proposes an opt-in timestamp on messages delivered to agents, including user prompts, messages from other threads, and delegated, background, and scheduled task notices. It suggests a stable timezone instruction and a short timestamp on each new message. This would give agents arrival times without changing instructions on every turn.

The search found no separate implementation PR matching the proposal. [Upstream PR #31825](https://redirect.github.com/pingdotgg/t3code/pull/31825) displays reply age in the thread list. [PR #33873](https://redirect.github.com/pingdotgg/t3code/pull/33873) distinguishes human and agent messages for thread sorting. Both are client behavior. The proposal and this experiment concern prompts received by the agent. Timestamping the agent's own replies would be separate work.

## Hook setup and delivery

Both harnesses accept a `UserPromptSubmit` command hook. Register it under `hooks.UserPromptSubmit` in the provider's configuration on the machine running the harness. Codex accepts `~/.codex/hooks.json` or inline hooks in `~/.codex/config.toml`. Review and trust the command via `/hooks` in Codex. Claude Code accepts `~/.claude/settings.json` for user scope or `.claude/settings.local.json` for a single checkout. If the provider uses a custom config home, use that home. [Codex hooks](https://learn.chatgpt.com/docs/hooks) · [Claude Code hooks](https://code.claude.com/docs/en/hooks)

For example, merge this entry into the JSON file and point it at a script on the provider host.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [{ "type": "command", "command": "python3 /path/to/prompt-timestamp.py" }]
      }
    ]
  }
}
```

The script reads the hook input from stdin and emits JSON. This example uses minute precision with a date and explicit timezone so the agent can compare prompts across midnight.

```python
import json
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

json.load(sys.stdin)
timestamp = datetime.now(ZoneInfo("America/Vancouver")).strftime("[%Y-%m-%d %H:%M PT]")
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "UserPromptSubmit",
        "additionalContext": timestamp,
    },
}))
```

This stamps the prompt when the provider handles it, which can be later than the original send time. To answer an age question without tools, the agent still needs a later timestamp as a reference. In a synthetic test, both models correctly inferred a seven-minute interval from two stamps and made zero tool calls. The hook-off controls could not establish the interval.

LastCode's built-in integrations delivered these hooks through Codex app-server and the Claude Agent SDK. Both models read timestamps on new task prompts, and both read a fresh timestamp on an actual agent-authored, queued `t3_thread_send` follow-up. LastCode sends the text to the recipient as a prompt. The sender's MCP tool result only reports delivery. One Codex conversation opened before the hook was configured returned no timestamp. The queued send succeeded after creating a Codex conversation with the hook already in place. For Claude, project-local settings worked in the LastCode probe.

The delivery tests cover new task prompts and queued cross-thread messages. Active-turn steering, scheduled or background notices, and compaction were outside the test.

## Cache measurements

The cache experiment ran the harnesses directly, using Codex CLI 0.171.0 with GPT-6 Luna and Claude Code 2.1.331 with Claude Haiku 5.5, both at low effort. It used 20 matched pairs per provider, each with five requests per condition. The order of hook-on and hook-off was balanced and randomized. Each pair shared a synthetic reference with a unique ID. Replies were fixed and tools were unused. New timestamps differed each turn. The first request seeded the cache. The harness process restarted before the fourth request and resumed the same conversation.

The table shows mean percentages of input tokens read from cache. The warm average covers turns 2, 3, and 5. Claude's denominator includes cache reads, cache writes, and ordinary input.

| Request             | Codex off | Codex on | Claude off | Claude on |
| ------------------- | --------: | -------: | ---------: | --------: |
| First follow-up     |    88.02% |   88.18% |     96.33% |    95.84% |
| Second follow-up    |    98.80% |   96.17% |     99.44% |    98.94% |
| First after restart |    36.10% |   33.37% |     99.43% |    98.93% |
| Next after restart  |    91.60% |   90.86% |     99.43% |    98.93% |
| Warm average        |    92.81% |   91.73% |     98.40% |    97.90% |

**Codex.** The large differences in the three-pair pilot did not repeat. For warm turns the paired 95% bootstrap interval was −8.49 to +6.31 percentage points for hook on minus off. The sample leaves room for a smaller change in cache reuse. All 40 first requests after restart reused less than 90% of their input. Separately, a local Responses endpoint captured Codex's outgoing JSON with a changing timestamp. Instructions, tool definitions, and every prior input item stayed identical across both a follow-up and a restart. That establishes that the hook preserved the input prefix in those requests. Cache availability in the live runs remains a separate question.

**Claude.** The first warm follow-up reused the same absolute number of tokens in every matched pair with and without the hook. Turns 3, 4, and 5 reused 31, 62, and 93 additional tokens, respectively, with the hook on. The lower percentages reflect the added input. Each of those requests, and the first follow-up, had 62 extra input tokens outside the cache when the hook was on.

**Cost.** With harness framing, the hook added about 17 input tokens per Codex prompt and 31 per Claude prompt. At OpenAI's published Standard overage rates for GPT-6 Luna, the observed warm Codex difference works out to roughly 6.2% more input credits, or 0.44 extra credits per 1,000 comparable requests. This weights the measured cached and uncached input at their respective rates. It excludes output and is an estimate for the sample, with no established causal link to the hook. The published credit rates do not give a direct conversion to the included subscription quota. [OpenAI pricing](https://learn.chatgpt.com/docs/pricing#token-rates)

## If the idea is revisited

For a built-in option, stamp each newly delivered message once and leave earlier context intact. That allows the app to use its recorded time and keep different message sources distinguishable. The main questions left are coverage on steering and automated notices, and how much cache reuse changes across normal LastCode sessions with longer histories and idle gaps.
