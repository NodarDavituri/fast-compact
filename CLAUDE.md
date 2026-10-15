# CLAUDE.md — fast-compact

A Claude Code function-hooks plugin: `/fast-compact` and `/fc` cut old tool output to its start and end, Jev (TypeSafe's System One model, via OpenRouter or TypeSafe) choosing what stays whole, every cut saved to `~/.claude/fast-compact/<session>/`. Native `/compact` is never touched. The README says what and why; `bench/RESULTS.md` holds the numbers the design rests on.

## Layout

- `src/` — the logic: `compact.ts` (plan, choose, apply, `fresh`), `state.ts` (the Jev state, adapted from upstream), `jev.ts` (questions, batching, providers, errors), `text.ts` (cuts, markers, well-formed slicing), `redact.ts`, `types.ts` (options and defaults). No Node APIs and no dependencies: a hooks module runs in Claude Code's own environment (no DOM, no Node, no `require`, no `toWellFormed`).
- `hooks/fast-compact.ts` — the Claude Code side; `hooks/hooks.json` names it.
- `tests/core/*.spec.ts` — `bun test tests/core`. `tests/plugin/*.test.ts` — `claude plugin test .` (Claude Code's test host; `bun test` must not pick these up, hence the two suffixes).
- `bench/` — the replay bench over local transcripts; `bench/upstream/` is tamaratran's library frozen at `e3f262a`, used only to measure it.
- `docs/design.md` — why it is shaped this way: decisions, what was turned down, Jev facts, open issues. Read it before changing what gets cut or kept.

## Commands

```sh
bun run typecheck
bun run test
bun run validate
OPENROUTER_API_KEY=… bun bench/run.ts --jev [--write]
```

Develop against this folder with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`; an installed copy lives in Claude Code's plugin cache and is not edited.

A release bumps `version` in `.claude-plugin/plugin.json` (and `package.json` to match; a minor bump for a new option): installed copies update only when that version changes. The marketplace entry carries no version of its own, since `plugin.json` would silently win over it. Add the version's notes to `CHANGELOG.md` (what changed, and anything a user must do), run typecheck, test and validate, push to `main` (commit `fast-compact X.Y.Z: <summary>`), tag it `vX.Y.Z` and publish a GitHub release whose notes are the version's `CHANGELOG.md` entry (`gh release create vX.Y.Z --title "fast-compact X.Y.Z" --notes-file <entry>`), then check with `claude plugin marketplace update fast-compact && claude plugin update fast-compact@fast-compact`, which should say it updated from the old version to the new. Before a release that touches the hook, the live check in `bench/RESULTS.md` is the smoke test: read 14 files of ~7k characters with a fact in the middle and one at the end, `/fc`, ask for a middle fact (Claude should grep the archive), then `/exit`, `--resume` and confirm the markers are still there.

The typecheck reads Claude Code's plugin API types from `.claude-plugin/types/` (gitignored), which Claude Code writes itself when a session loads this folder as a plugin; there is no command for it. `claude plugin validate`, `claude plugin test` and a headless `claude -p --plugin-dir .` do not write them. Loading Claude Code's bundled `plugin-authoring` skill does write a current `claude-code.d.ts` (to a per-process folder; copy it into place). After upgrading Claude Code, compare the first line of `.claude-plugin/types/claude-code/index.d.ts`: a stale folder lingers. The `/plugin-types` command the old `types` script called is gone (2.1.296), and `claude -p /plugin-types` sends it to the model as a prompt instead — in this repo the model then ran the script again, recursing.

## Rules for changes

- **Public repo.** `bench/.cache/` (Jev answers, per-candidate rows keyed by session-id prefixes, blind-check batches with transcript text) and `.claude/types/` (lists the local MCP tools) are gitignored and never committed. Bench output that reaches `RESULTS.md` carries counts only: a point id is a session-id prefix, and an OpenRouter error body carries the account id. No personal names, paths, project names or session ids in commits.
- **Evidence first.** A new heuristic for what to keep or cut goes through the bench before `src/` (ranking errors first looked sensible and measured worse). The numbers behind each default are in `docs/design.md`.
- **Nothing is cut unless its full text was saved.** Archive file names take only safe characters from the tool_use_id and the input field name (an MCP tool's field may hold `/` or `..`); an output over 1M characters is split into `.partN` files, since `$.fs` refuses a write over 4 MiB in bytes, and the marker names every part.
- **`wasCut` matches the whole marker shape**, not its opening: an output that quotes the marker (a grep of the archive, this repo's source) must still be cuttable.
- **A main-conversation `manual` or `plugin` compaction whose instructions start with `[fast-compact]` is always this plugin's**, pending `/fc` or not: it is answered, or skipped on failure, and never reaches the summary — as long as the hook runs at all. Where an organization manages Claude Code, `session.compact` hooks pass over plugins a person installs (`claude plugin validate` warns of it, 2.1.300), the marked `/compact` gets core's summary, and the plugin only learns afterwards that no report was set: it logs `MISSED` and turns `/fc` and the meter off for the session. The pending state only refuses a second `/fc`, and is cleared only by the same `/fc` that set it.
- **Earlier cuts count in the `keepWhole` budget at their full size** (`plan().cutBefore`, read off the marker's `cut N chars`). Without it each `/fc` keeps a quarter of what the last one kept whole, and the meter invites the next run.
- **Redaction runs per string on already-truncated text**, so a pattern cannot rely on a closing line (a private key cut before its `END`).

## Host rules learned the hard way (Claude Code 2.1.283; the suite also passes on 2.1.296 and 2.1.300)

- A compaction started from inside a `command.run` hook is refused ("it would compact under the turn this hook is holding").
- A compaction a plugin starts itself (`$.session.compact` from a timer callback) skips every hook of that plugin ("re-entry … origin fast-compact") and core summarises. So `/fc` schedules Claude Code's own `/compact` with the instructions `[fast-compact] <focus>` via `$.clock.after` + `$.command.run`, and the `session.compact` hook takes any main-conversation `manual` or `plugin` compaction whose instructions start with that marker (the pending state only refuses a second `/fc` while one runs). That compaction arrives with trigger `manual`, not `plugin`.
- A `session.compact` hook that throws or overruns its 10 s of own compute is skipped and core summarises in its place: every failure on our own compaction must answer `{ skip }` (the `.catch` handler does). `$.clock.sleep` counts against the budget (other `$` calls do not), so Jev's waits are sized from `next.budget.remainingMs`, keeping a reserve for the archive writes.
- Messages handed back with the engine's `handle` make `--resume` walk back into the full pre-compaction history (anthropics/claude-code#95328, upstream #89); `fresh()` drops handles, and empty (thinking-only) messages with them.
- The engine writes each handle-less message as a turn of its own, so a parallel batch handed back as separate messages reaches the model with every call but the last unanswered ("Tool result missing due to internal error"). `fresh()` merges consecutive assistant messages, and consecutive result-only user messages, into one.
- A hook failure (`next.error`) is a plain object `{ kind, message?, budget }`: format it as `kind: message`, never `String()` (`[object Object]`).
- A hot reload re-runs `register` and fires `session.start` again: module-level variables (the pending `/fc`, the report) reset; `$.state` and `$.store` persist.
- The loader refuses a module statically: a helper that takes `$` must be a top-level function whose name no other declaration uses; `$` is spelled `$.noun.verb(...)` at the call site, never optional-chained or bound; `$.env.get` takes a literal name. `claude plugin validate` reports these; vitest-style runs never see them. A load failure is silent in the TUI, except for a dim line in a session that hot-reloaded the folder — check `--debug-file`.
- The test host runs from the plugin root (`claude plugin test .`); a stub answers `{ value }` or `{ deny }` and cannot be registered twice, so the fake world takes options instead. A test's plugin options go in its second argument, `{ options: {...} }`.
- `session.measure` fires on rate-limit and cost changes too; the meter reads the transcript only when `e.changed` includes `context` (a full read and cut took 1.2 s on a 20M-character transcript).
- A string `userConfig` field with `options` is a picker in `/config`, and a stored value outside the list counts as unset (its default applies). `provider` has no list on purpose: an unknown value must mean `none`, never the OpenRouter default.
- With `resumeSafe` off, a rebuilt message in a parallel batch would split it as above; `freshBatches()` merges just those turns and leaves every other handle in place.
- `claude plugin validate` warns that the root `CLAUDE.md` is not loaded: expected, it is a developer file.
- `$.fs` refuses paths it reads as network locations — on macOS that includes `/home/...` (an automount), so tests use `/Users/tester`.
- `$.ui.log` lines logged during a compaction vanish with the screen reset; the report is logged after the `/compact` resolves. The host prefixes plugin output with the plugin's name.
- `$.http.fetch` has no timeout; it is raced against `$.clock.sleep`.
