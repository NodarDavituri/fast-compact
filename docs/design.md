# Design notes

Why fast-compact is shaped the way it is: the decisions, the alternatives turned down, and what is still open. The README says what the plugin does; `bench/README.md` and `bench/RESULTS.md` hold the method and the numbers; `CLAUDE.md` holds the rules for working in the repo.

## Where it came from

[tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) (frozen in `bench/upstream/` at `e3f262a`) had the idea: ask Jev cheap yes/no questions instead of running a slow summary. Its issues and PRs did most of the measuring before this repo existed. Several independent replays there (#26, #52, #53, #56, #99) found that the shipped questions dropped nearly every call outside the newest few; a fake Jev answering "no" to everything freed about the same amount (88.5% against 87.7%); rewording the question with explicit true/false criteria lifted ranking accuracy from about 0.54 to 0.72; and the one independently labelled replay found "keep the largest" and a plain head-and-tail cut doing as well as Jev. The bench here reproduced that before anything was built.

This is a standalone repository carrying upstream's history (so tamaratran's authorship stays), not a GitHub fork: forks with fewer stars than their parent are left out of search, read as patch branches and have issues turned off. Upstream PRs can still be picked up with `git fetch upstream pull/<n>/head`.

## Decisions

**A command of its own; `/compact` untouched.** Upstream took over `/compact` and auto-compaction, with the built-in summary as fallback. Here `/fc` cuts and never summarises; Claude Code's summary stays available as `/compact`. `autoCompact` (off by default) later brought the cut to auto-compaction, falling back to the summary when the cut would free under a fifth of the conversation, because a context left near its threshold compacts again a few turns later.

**Calls are never deleted.** When a call was deleted but the assistant's narration about it stayed, one session went on to report nine pieces of work it had never done (upstream #65). A note saying the call had been removed did not help: the model copied the note. So every call stays, long outputs keep their start and end, and the marker names the file holding the whole.

**The cut text is saved, not lost.** About 40% of the outputs readers judged needed had the useful part in the middle or spread throughout (bench blind check), which no head-and-tail cut keeps. The archive lives in `~/.claude/fast-compact/<session>/`, outside the project and beside the transcripts that already hold the same text.

**What the kept 1,000 + 500 characters are for.** They are for Claude, not Jev: Jev decides before anything is cut, from a 200 + 100 character sample, so its scores do not depend on the cut size. The kept start and end often hold the needed detail, and they tell Claude what was cut so it knows to read the file. Sweeping the kept size under the shipped rule:

| Characters kept per cut | Old output kept | Needed outputs still usable without a lookup |
|---|---|---|
| 300 | 36% | 53% |
| 600 | 43% | 60% |
| 1,000 | 50% | 67% |
| 1,500 (default) | 57% | 75% |
| 2,500 | 66% | 80% |

There is no knee: going from 1,500 to 600 frees about 7% more of the whole context and sends Claude to the archive about 60% more often. `cutTo` = 1500 is a judgement, not a tuned optimum.

**Jev ranks; code decides.** Jev's probabilities are used as a ranking, and code keeps whole the best-ranked outputs within a character budget (`keepWhole`), instead of trusting a fixed 0.5 cutoff (upstream #56). `minKeepScore` 0.45 and `keepWhole` 0.25 were read off the score spread on the blind-judged items, not swept.

**How much Jev adds, honestly.** At equal size, Jev's pick keeps 75% of later-needed outputs usable against 69% for cutting every output; against keeping the newest whole it is 75% against 73%, while keeping 4 points less text. Of the 266 later-needed outputs across the 122 replayed compactions, the first gap is about 16 outputs (one saved file read per eight runs), the second about 5 (one per 24 runs). Most of the value is the rest: about a second instead of a summary, word-for-word text instead of a paraphrase, and the archive. So Jev is optional: with no key, or `provider` set to `none` (0.3.0), the plugin keeps the newest whole and sends nothing.

**Samples are a privacy trade.** `sendSamples` sends the start and end of each ranked output. It helps a little: AUC 0.725 with against 0.721 without on the token label, 0.789 against 0.755 on the readers' judgement.

**Rules need bench evidence.** Ranking errors first (`errors_then_newest`, `jev_needed+errors`) showed no gain (AUC 0.719 against 0.725), so it was not adopted. A new heuristic goes through the bench before it goes into `src/`.

**Smaller rules taken from upstream's tracker:** never ask Jev again about an output already cut (#77); cut host notices by rule rather than by Jev (#78); take the goal from the person's own prompts plus the `/fc` focus, not from host text (#39, #78); protect recent history by tool calls, since the host splits one reply into many messages (#65); drop empty messages (#79); validate every probability Jev returns (#29); cap concurrent requests (#33); never let a Jev failure fail the compaction (#36); estimate tokens for hashes and ids at a token per three characters (#81, #85).

## Turned down

- **Starting the compaction from `command.run`** (upstream PR #20's approach): the host refuses a compaction under the turn the hook holds. `/fc` schedules Claude Code's own `/compact` with a marker instead (`CLAUDE.md`, host rules).
- **Summarising what was dropped** (#15): 30–76 s a run, the cost this plugin exists to avoid.
- **Compacting conversation text** (#68): everything a person or Claude wrote stays; `/compact` is for that.
- **Trimming Bash output as it arrives** (#18): it adds a delay to every call. Possibly later.
- **Upstream's npm package, demo app and ports**: out of scope for a plugin.

## Jev

- OpenRouter serves Jev at `https://openrouter.ai/api/v1/systemone` (also `/api/alpha/decisions`, same body); TypeSafe at `https://api.typesafe.ai/v1/systemone`. TypeSafe's own endpoint sits behind a web firewall that answers an HTML 403 to requests carrying shell, SQL or file paths (upstream #97) — most real sessions — so OpenRouter is the default, and an HTML 403 is reported as the firewall, not the key.
- `jev-latest` and `jev-1.13` both resolved to `typesafe/jev-1.13-20260917` during development, answering in about 300 ms. Each response carries its cost; about $0.04 per million input tokens, so a full request costs around $0.001 and the whole bench under $1.
- `jev-latest` will move. The ledger records the model that answered; the bench numbers hold for jev-1.13-20260917, so rerun the bench when the model changes.
- Request limits: 32k tokens for the state plus the longest question, and the request as a whole under `maxRequestTokens` (`src/jev.ts`).

## Open

- **The ledger is read, then written.** Two sessions compacting at once can lose a line, and a month's file stops growing past the host's 4 MiB read limit.
- **Redaction gaps.** Masking is by pattern over already-truncated strings; forms like `mysql -p<password>` are not caught.
- **Host behaviour not in the types:** how commands typed during a compaction are queued (a second `/fc` was seen to queue, find nothing to cut and say so), and the order hooks of different plugins run in. Another plugin rewriting a compaction's instructions would strip the marker; nothing here can prevent that.
- **The `autoCompact` spinner** stuck on "Running SessionStart hooks…" (2.1.296, README Limits) is not reported to Claude Code yet.
- **Not measured:** what a lookup costs, whether Claude notices a needed cut when less is kept, downstream task quality, and anyone's sessions but one person's.
- **Ideas:** try `cutTo` 1000 and check in the ledger and transcripts how often Claude reads the archive; trim Bash output; a downstream-task evaluation; the bench over other people's sessions.
