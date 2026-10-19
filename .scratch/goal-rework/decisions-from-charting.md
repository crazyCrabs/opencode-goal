# Jev verdicts — opencode-goal rework decision set

Run: `node jev-decide.mjs` against `https://api.typesafe.ai/v1/systemone`
Model: `jev-1.13.0` · usage 4814 in / 440 out · 9 questions in one call
Payload: `jev-decide.mjs` in this directory

Confidence routing floor: 0.6. Answers below it are escalated, not acted on.

## Settled (confidence ≥ 0.6)

| Question | Verdict | Prob | Conf |
|---|---|---|---|
| `pain_is_model_facing` (noul) | **YES** — the pain is model-facing, not human-facing | 0.65 | — |
| `q1_experience_surface` | **continuation-loop** | 0.80 | 0.74 |
| `q2_destination_form` | **spec** | 1.00 | 1.00 |
| `q4_reference_authority` | **constraint-with-recorded-exceptions** | 0.98 | 0.97 |
| `q5_verify_before_design` | **record-real-event-stream-first** | 0.90 | 0.85 |
| `q6_definition_of_done` | **runnable-scenario-recording** | 1.00 | 1.00 |

`model-tool-contract` scored 0.01 and `human-command-plane` scored 0.00 — the
model-facing tools and the TUI command plane are explicitly *not* the primary
target, even though the architecture review found real friction in both.

Note on Q5: Jev chose the option that makes the human's live-server
observation unnecessary — the recording settles the three contradictions
empirically. The choice is robust to not knowing that fact.

Note on Q6: `runnable-scenario-recording` scored a unanimous 1.00 against
`subjective-bar` 0.00. A subjective red line is an *addition* to this, not an
alternative to it.

## Escalated (confidence < 0.6)

### `q3_cas_ref_fate` — confidence 0.14

| Option | Prob |
|---|---|
| hide-internally | 0.42 |
| remove-model-lifecycle-mutation | 0.39 |
| keep-in-model-interface | 0.19 |

Read the distribution, not the winner: the two top options sum to **0.81**.
Jev is confident about the *direction* — move the compare-and-set ref out of
the model interface — and split on the *distance*: hide it behind the server,
or remove lifecycle mutation from the model entirely (the Codex answer).

### `q7_completion_semantics` — confidence 0.50

| Option | Prob |
|---|---|
| self-declare-with-three-round-gate | 0.67 |
| model-self-declare | 0.33 |
| external-verification | 0.00 |

`external-verification` scored exactly 0.00 across the board — a strong
negative. The open question is whether the model self-declares freely or
carries the three-round blocker gate both references converged on.

### `lock_before_code` — score 1.3

| Level | Prob |
|---|---|
| Loose (code now, design settles as it goes) | 0.00 |
| Moderate (destination + model-facing interface first) | 0.70 |
| Firm (every decision incl. v2 facts) | 0.30 |

1.3 sits between moderate and firm, leaning moderate. `firm` at 0.30 is not
negligible — the three unverified opencode v2 facts are the mass pulling it up.

## What the escalations have in common

All three are *distance* questions, not *direction* questions:

- q3: how far to take the ref out of the model's hands (direction settled, distance split)
- q7: whether to add the gate on top of self-declaration (direction settled, gate split)
- lock: how much to lock before code (direction settled, firmness split)

So the human decisions are three dials, not three forks. Each still needs a call.
