# Replay bench

Replays compaction points from your own Claude Code transcripts and measures how well each way of choosing what to cut keeps the tool output the session went on to need. It exists to decide how `/fast-compact` chooses, before the plugin is built on a guess.

```sh
bun bench/run.ts                  # methods that need no network
OPENROUTER_API_KEY=… bun bench/run.ts --jev          # plus the Jev methods
OPENROUTER_API_KEY=… bun bench/run.ts --jev --write  # and write RESULTS.md
bun bench/spotcheck.ts export     # a blind sample for checking the label by hand
bun bench/spotcheck.ts score
```

Options: `--n 150` points to sample, `--root <dir>` for the transcripts (default `~/.claude/projects`). `JEV_BASE_URL` and `JEV_MODEL` switch the endpoint (default OpenRouter's `https://openrouter.ai/api/v1/systemone`, `jev-1.13`); a `TYPESAFE_API_KEY` works with `JEV_BASE_URL=https://api.typesafe.ai/v1/systemone`.

## Method

**Transcripts** (`transcript.ts`). Each `.jsonl` is cut into segments at its compaction boundaries; within a segment the conversation is the parent chain walked back from its last message (a rewound branch is left out), one message per content block, as a `session.compact` hook receives it. Sidechains (subagents) are left out.

**Points** (`points.ts`). A point is the first assistant message of a segment whose recorded context passed a threshold (100k, 200k, 300k, 450k, 600k, 800k tokens), provided the session then made at least 40 more tool calls without compacting — so the work after the point was done with the whole history in view and shows what the history was needed for. The sample takes points with at least 10 candidates, at most three per session and twelve per project, round-robin across projects.

**Candidates** are tool results before the point that a compaction could cut: at least 500 characters, outside the first message and the newest six (upstream's pinning).

**The label.** A candidate is *needed* when a distinctive token it introduced — a path, a number, or an identifier with a digit or underscore, 8+ characters (upstream #99's definition) — is used by the assistant, in its text or a tool input, within the 40-call window. Three exclusions keep it honest:

- the token appeared before the result (the result did not introduce it);
- it appeared again anywhere between the result and the point (the history carries it without this result — including the assistant having already restated it, the circularity #99 warns about);
- in the window a tool result or a user message carried it before the assistant used it (the use did not depend on the history).

It is a proxy: it misses a result whose *meaning* mattered without any token being reused, and it favours large outputs (more tokens, more chances). `spotcheck.ts` measures how far it agrees with a reader who judges blind.

**Methods** (`arms.ts`), each a score per candidate: `random`; `newest`; `largest`; `smallest`; `errors_then_newest`; `oracle` (the label itself — the ceiling); `jev_upstream` (upstream's state, its two questions, its `keepResult` answer); `jev_needed` (the reworded question — "holds something the assistant will need again" — with true/false criteria and a 300-character sample of the output inside the question, over upstream's state with the goal taken from the person's own prompts); `jev_needed_nosample`; `jev_needed+errors`.

**Metrics** (`metrics.ts`).

- *AUC* of each score against the label, pooled and averaged per point (0.5 is a coin flip).
- *At a budget* of 15%, 30% and 50% of the candidates' characters: every candidate becomes a stub (first 200 and last 100 characters) unless the method keeps it whole, in its own order, while the total fits. Reported: the share of needed tokens that survive, and the share of needed results that keep at least one. 95% intervals by bootstrap over points.
- `head_tail` cuts every result to the same fraction (70% from the start, 30% from the end); `head_tail tilted by <score>` lets a score shift how much of each result is kept, at the same total.
- *Upstream as shipped*: its own decisions at its 0.5 threshold (keep, truncate to a 300-character head, or drop call and result).

Jev requests carry the conversation text and tool inputs (and, for `jev_needed`, output samples); credential-shaped strings are masked per string before sending. `bench/.cache/` (gitignored) keeps the answers by request hash, so a rerun costs nothing, and per-candidate rows with ids, sizes, labels and scores only.
