# CLAUDE.md — fast-compact

A Claude Code function-hooks plugin: `/fast-compact` and `/fc` cut old tool output to its start and end, Jev (TypeSafe's System One model, via OpenRouter or TypeSafe) choosing what stays whole, every cut saved to `~/.claude/fast-compact/<session>/`. Native `/compact` is never touched. The README says what and why; `bench/RESULTS.md` holds the numbers the design rests on.

## Layout

- `src/` — the logic: `compact.ts` (plan, choose, apply, `fresh`), `state.ts` (the Jev state, adapted from upstream), `jev.ts` (questions, batching, providers, errors), `text.ts` (cuts, markers, well-formed slicing), `redact.ts`, `types.ts` (options and defaults). No Node APIs and no dependencies: a hooks module runs in Claude Code's own environment (no DOM, no Node, no `require`, no `toWellFormed`).
- `hooks/fast-compact.ts` — the Claude Code side; `hooks/hooks.json` names it.
- `tests/core/*.spec.ts` — `bun test tests/core`. `tests/plugin/*.test.ts` — `claude plugin test .` (Claude Code's test host; `bun test` must not pick these up, hence the two suffixes).
- `bench/` — the replay bench over local transcripts; `bench/upstream/` is tamaratran's library frozen at `e3f262a`, used only to measure it.

## Commands

```sh
bun run types      # .claude/types from the installed Claude Code (gitignored; the MCP file lists local tools)
bun run typecheck
bun run test
bun run validate
OPENROUTER_API_KEY=… bun bench/run.ts --jev [--write]
```

## Host rules learned the hard way (Claude Code 2.1.283)

- A compaction started from inside a `command.run` hook is refused ("it would compact under the turn this hook is holding").
- A compaction a plugin starts itself (`$.session.compact` from a timer callback) skips every hook of that plugin ("re-entry … origin fast-compact") and core summarises. So `/fc` schedules Claude Code's own `/compact` with the instructions `[fast-compact] <focus>` via `$.clock.after` + `$.command.run`, and the `session.compact` hook takes the compaction whose instructions carry that marker while a request is pending. That compaction arrives with trigger `manual`, not `plugin`.
- A `session.compact` hook that throws or overruns its 10 s of own compute is skipped and core summarises in its place: every failure on our own compaction must answer `{ skip }` (the `.catch` handler does). Waiting on `$` calls does not count against the budget.
- Messages handed back with the engine's `handle` make `--resume` walk back into the full pre-compaction history (anthropics/claude-code#95328, upstream #89); `fresh()` drops handles, and empty (thinking-only) messages with them.
- The loader refuses a module statically: a helper that takes `$` must be a top-level function whose name no other declaration uses; `$` is spelled `$.noun.verb(...)` at the call site, never optional-chained or bound; `$.env.get` takes a literal name. `claude plugin validate` reports these; vitest-style runs never see them. A load failure is silent in the TUI — check `--debug-file`.
- `$.fs` refuses paths it reads as network locations — on macOS that includes `/home/...` (an automount), so tests use `/Users/tester`.
- `$.ui.log` lines logged during a compaction vanish with the screen reset; the report is logged after the `/compact` resolves. The host prefixes plugin output with the plugin's name.
- `$.http.fetch` has no timeout; it is raced against `$.clock.sleep`.
