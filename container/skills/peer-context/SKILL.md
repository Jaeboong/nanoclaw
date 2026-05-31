---
name: peer-context
description: Fetch the most recent messages from other AI bots running in the same channel. Use when the user explicitly references another bot's response (cross-check, comparison, integration, "다른 봇이 뭐라고 했어"). Do NOT use for ordinary questions where the user is not referencing another participant — answer those independently.
---

# peer-context — On-demand peer-bot history

By default you do **not** see other AI bots' messages in this channel. Each agent thinks independently to avoid anchoring and token cost. When the user's request explicitly requires knowing what another bot just said, call this skill to pull the missing context on demand.

## When to call

Trigger conditions (any one is enough):

- User asks you to compare, cross-check, integrate, or react to another bot's recent answer.
- User asks a meta question: "저쪽은 뭐래?", "통합본 만들어줘", "교차검증해", "다른 봇 답변 보고 보완해".
- A flow-control / handoff cue mentions another participant.

## When NOT to call

- Default. Most messages are direct questions to you — answer them on your own.
- The user is not referencing any other bot's response. Scrollback may contain peer-bot messages, but that alone is not a reason to fetch them.
- You already have enough information from the user's message and your own memory.

Calling unnecessarily wastes tokens and biases your response toward the peer bot's framing.

## How to call

Use the MCP tool `mcp__nanoclaw__peer_history`.

Arguments (all optional):

| Arg | Default | Notes |
|-----|---------|-------|
| `limit` | 3 | Number of most recent peer-bot messages. Clamped to [1, 20]. |
| `since` | none | ISO-8601 timestamp; return only messages strictly newer than this. |

The tool returns messages chronologically (oldest first), each with sender name, content, and timestamp. The host validates that you only see messages from your own channel.

## Example

User: "저쪽 나붕봇 답변하고 합쳐서 통합본 만들어줘."

You: call `mcp__nanoclaw__peer_history` with `limit: 3`, read the peer's recent reply, then write the integration. Cite both viewpoints, don't just defer to the peer's framing.

User: "오늘 점심 뭐 먹지?"

You: answer directly. Do **not** call `peer_history` — the user is not asking about any other bot.
