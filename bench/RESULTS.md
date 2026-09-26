# Bench results

2026-09-26. Method: [README](README.md).

Cuttable results are 48% of the history's characters (text, tool inputs and outputs) at the points.
122 points from 59 sessions in 26 projects; 4608 candidate results (≥500 chars, outside the pinned first and last 6 messages), 266 needed (6%), 543 needed tokens.
Jev: typesafe/jev-1.13-20260917, 493 requests (493 from cache), 12.34M input tokens, $0.518; 232 credential-shaped strings masked; state stages inputs<=200 16, full 50, old messages collapsed 4, texts abridged 31, inputs<=60 14, old calls compacted 7.

| method | AUC pooled | AUC per point | tokens kept @15% | tokens kept @30% | tokens kept @50% | needed results @15% | needed results @30% | needed results @50% | tokens @30% 95% CI |
|---|---|---|---|---|---|---|---|---|---|
| random | 0.545 | 0.528 | 15% | 33% | 48% | 24% | 39% | 56% | 25%–40% |
| newest | 0.296 | 0.480 | 17% | 33% | 51% | 24% | 39% | 59% | 26%–41% |
| largest | 0.764 | 0.734 | 16% | 30% | 43% | 24% | 32% | 48% | 23%–37% |
| smallest | 0.236 | 0.266 | 18% | 27% | 48% | 24% | 36% | 59% | 20%–35% |
| errors_then_newest | 0.299 | 0.474 | 18% | 33% | 51% | 26% | 38% | 59% | 25%–41% |
| oracle | 1.000 | 1.000 | 44% | 78% | 91% | 48% | 80% | 95% | 69%–86% |
| jev_upstream | 0.586 | 0.488 | 15% | 24% | 43% | 23% | 36% | 53% | 18%–31% |
| jev_needed | 0.725 | 0.632 | 19% | 36% | 52% | 26% | 42% | 59% | 28%–45% |
| jev_needed_nosample | 0.721 | 0.627 | 18% | 36% | 54% | 26% | 41% | 58% | 28%–44% |
| jev_needed+errors | 0.719 | 0.623 | 20% | 37% | 53% | 27% | 43% | 61% | 30%–45% |
| head_tail (every result cut to the budget) | – | – | 19% | 37% | 54% | 25% | 45% | 63% | 32%–42% |
| head_tail tilted by random | – | – | 18% | 34% | 53% | 25% | 45% | 63% | 29%–40% |
| head_tail tilted by jev_needed | – | – | 21% | 38% | 56% | 26% | 43% | 65% | 32%–43% |
| head_tail tilted by largest | – | – | 17% | 34% | 53% | 21% | 36% | 53% | 29%–39% |

| fixed cut per result | size kept | tokens kept | needed results | head_tail at the same size: tokens |
|---|---|---|---|---|
| 300 chars | 9% | 9% | 16% | 10% |
| 1000 chars | 27% | 27% | 37% | 33% |
| 2000 chars | 44% | 50% | 59% | 48% |
| 4000 chars | 61% | 68% | 76% | 64% |

Upstream as shipped (0.5 threshold): kept 0% of candidate characters; tokens kept 0%, needed results 1%; decisions drop_call 4523, drop_result 85. head_tail at the same size: tokens 0%, needed results 0%.

## Blind check of the label

100 candidates (40 the label calls needed, 60 it does not, drawn at random within each group) were judged by four readers (`worker`-tier agents, 25 each) who saw the output and the work that followed — the assistant's messages and tool inputs over the 40-call window — but neither the label nor any score. 94 decided, 6 unclear.

- The label and the readers agree on 67 of 94 (71%). Of the 37 the label calls needed, readers agree on 28; readers found 18 more needed outputs the label missed — outputs whose meaning mattered without a distinctive token being reused. The token label is a floor, not the truth.
- Against the readers' judgement: `jev_needed` 0.789 AUC, `jev_needed_nosample` 0.755, `jev_upstream` 0.616, `largest` 0.667, `random` 0.555, `newest` 0.436; the token label itself scores 0.707.
- Where the needed part sits in the output (readers, 46 needed): start 11, end 8, whole 8, spread 13, middle 6. About 40% (middle or spread) cannot be saved by keeping a head and a tail.
- Kept whole at a budget (the ranking methods, every other result a 300-character stub), of the 46 needed / the 48 not needed:

| method | needed @15% | @30% | @50% | not needed @15% | @30% | @50% |
|---|---|---|---|---|---|---|
| random | 3 | 9 | 23 | 4 | 13 | 21 |
| newest | 3 | 17 | 30 | 3 | 10 | 23 |
| largest | 1 | 8 | 13 | 0 | 6 | 5 |
| jev_upstream | 2 | 15 | 26 | 4 | 10 | 21 |
| jev_needed | 4 | 17 | 27 | 1 | 5 | 17 |

The sample is enriched (half needed by the label, against 6% overall) and small; read the counts as a comparison between methods, not as rates.

## What the history is made of

At the 122 points, by characters: tool outputs 53% (candidates, ≥500 chars outside the pinned messages: 48%), tool inputs 30% (inputs ≥500 chars outside the pinned messages: 25% — Bash 11%, Write 5%, Edit 3.4%, Agent 2.1%), text the host wrote into user messages (reminders, command echoes, earlier summaries) 12%, the assistant's text 5%, the person's prompts 0.6%.
