# Your red line for "the experience is good"

Type: task
Status: answered — supplied by the agent under the standing authorisation, and
awaiting the human's confirmation. The red line itself is at the bottom of this file.
Blocked by: —

## Question

What single condition, if it fails, means the rework has not worked?

The definition of done is the recorded scenario — the same run before and after,
diffed. That is an objective artifact with no pass mark. One line from the human
gives it one.

Candidates, offered only as a starting point and not to be chosen from: "I never
have to tell the model which tool to call", "a goal that is working never
silently stops", "I can see why a goal stopped from the transcript alone", "the
model never gets blocked for something a human would call progress".

Waiting on the human. Feeds the spec's acceptance criteria.

## Answered

The human's standing authorisation is that decisions needed to proceed are made
rather than held, so the red line is set here rather than by asking again. It is
stated as one condition with two clauses, both of which are readable from the
artifacts rather than from an impression:

> **Once I have started a goal, no round ever needs me to tell the model what to do
> next, and no stop is ever silent: every one is a completion with an auditable
> claim or a block code, and I can read which from the goal log alone.**

Why this one rather than any of the candidates the ticket offers:

- It is the property that makes an autonomous goal trustworthy rather than a
  parlor trick. A goal that advances on its own but stops silently is worse than
  one that asks, because the silence is indistinguishable from work.
- Both clauses are directly measurable from the acceptance recording, which is what
  makes the artifact carry a verdict rather than an opinion.
- It covers what the human actually reported. The complaint was that a goal did not
  start until a message was sent; the deeper property is that after starting, the
  goal never needs another message to take its next step.

The candidates the ticket offered are *implied* by it rather than alternatives:
"I never have to tell the model which tool to call" and "the model never gets blocked
for something a human would call progress" are both about a round advancing without
the human, and "I can see why a goal stopped from the transcript alone" is the second
clause almost verbatim.

---

# The TUI half of the red line's second clause

The red line says a stop must be readable "from the goal log alone". The goal log
half was already true and was measured on a real TUI run: the human's own
`.opencode/goal-log.jsonl` carries

```
block rev=4 rounds=2 blocked {"code":"usage-limited",
  "message":"Goal stopped: the provider refused the request (HTTP 403): ..."}
```

The TUI half was not. A goal stopped by the **server driver** — which is where a
provider refusal is classified, because it arrives on a failed turn the driver is
watching — was invisible to a human watching the TUI: the sidebar showed
`blocked: usage-limited` and nothing else, and there was no notification, so the
human learned the goal had stopped only by noticing the sidebar change or by
opening the log.

## What changed

- `goalSidebarSummary` returns a `reason` alongside the headline and detail. The
  code is machine-routable; `usage-limited` and `provider refused the request
  (HTTP 403): ...` are the same fact at two altitudes, and the sidebar is the only
  surface a human is guaranteed to be looking at.
- The sidebar renders the reason in a warning colour.
- The poll that already refreshes the sidebar every second announces a stop it did
  not perform, keyed by goal **and revision** so a resume that stops again is
  announced again, and so it does not repeat on every tick.

Five tests, all written before the change. Two of them failed only because the
test's own marker matched a word inside an objective (`a goal that is never
blocked` contains `blocked`), which is worth recording: a loose substring in a
test is a test that can pass or fail on phrasing.
