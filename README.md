# fast-compact

A second compaction command for Claude Code. `/fast-compact` — or `/fc` — cuts old tool output down to its start and end in about a second, lets Jev (TypeSafe's decision model) keep whole the outputs the work still needs, and saves everything it cuts to a file named in its place. Claude Code's own `/compact` is untouched: run `/fc` routinely, and `/compact` when the conversation itself needs summarising.

```
❯ /fc
  ⎿  fast-compact: compacting…
❯ /compact [fast-compact]
  ⎿  Compacted
⏺ fast-compact: 103k → 81k chars (−21%); 4 outputs cut; Jev typesafe/jev-1.13-20260917: 1 request, 0.6 s, $0.0002.
  Full text of every cut: ~/.claude/fast-compact/<session>/
```

## What it does

- The newest 10 tool calls, and every word you or Claude wrote, stay exactly as they are.
- Older tool outputs longer than ~2,000 characters keep their first 1,000 and last 500 characters around a marker: `[fast-compact: cut 5707 chars from the middle of this output; the full text is in ~/.claude/fast-compact/<session>/output-<id>.txt — read it before relying on what was cut]`.
- Jev ranks those outputs by whether the work will need them again; the top-ranked ones (score ≥ 0.45, up to a quarter of the old output's characters) stay whole.
- Long old tool inputs — Bash scripts, Write bodies, Edit strings — are cut the same way; old reminders and notifications keep their first 300 characters. No tool call is ever removed.
- Everything cut is written to disk first; an item that cannot be saved is not cut. Claude reads the file when it needs what was cut — in testing it did exactly that, with one grep, instead of guessing.
- If Jev is unreachable or no key is set, the newest outputs stay whole instead and the report says why. `/fc` never falls back to Claude Code's slow built-in summary.
- `/fc keep the migration plan` passes what you name to Jev as the focus.

## Why this and not fast-jev-compaction

[tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) had the idea: cheap Jev judgments instead of a slow summary. This plugin started from it, then measured it on 122 compaction points replayed from 59 real Claude Code sessions (4,608 tool outputs; method and every number in [bench/](bench/)):

- **As shipped it deletes almost everything.** Its keep scores never clear its own threshold: 98% of the old tool calls with sizeable output were deleted whole, together with that output, and ~0% of what the session later needed survived. As a ranking its scores are a coin flip (AUC 0.49 per point).
- **Deleted calls lead to invented reports.** With the calls gone and Claude's narration of them left behind, a session went on to report nine pieces of work it never did (upstream #65). Here no call is removed, and every cut says where its full text is.
- **It replaces `/compact`**, and falls back to the built-in summary whenever it frees too little. Here `/compact` stays yours and `/fc` never summarises.
- **`--resume` undid it** (upstream #89): the resumed session loaded the whole pre-compaction history. Here it doesn't — checked on Claude Code 2.1.283.
- **TypeSafe's firewall blocks real transcripts** (shell commands, SQL, paths → an HTML 403; upstream #97). OpenRouter's System One endpoint, the default here, does not; TypeSafe direct is still an option.

What the measurement found about Jev itself:

| same cutting rule, three ways to choose what stays whole | output text kept | details the session later reused, kept | outputs it later needed, kept |
|---|---|---|---|
| Jev's ranking (this plugin) | 57% | 69% | 75% |
| every output cut to its start and end, same size | 57% | 60% | 69% |
| the newest stay whole, no Jev | 61% | 66% | 73% |

A blind check agreed: four readers judged 100 outputs against the work that followed, and the shipped question ranked their judgement at AUC 0.75 (a reworded variant 0.79), against 0.62 for the original's question, 0.67 for largest-first and 0.56 for random. About 40% of the outputs they judged needed had the needed part in the middle — which is why nothing is cut without a copy on disk.

## Install

Needs Claude Code with function hooks turned on (an early-access plugin surface; built and tested on 2.1.283), and a key for Jev: an [OpenRouter](https://openrouter.ai) key, or a [TypeSafe](https://console.typesafe.ai/keys) key. In `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1", "OPENROUTER_API_KEY": "sk-or-…" } }
```

Then:

```sh
claude plugin marketplace add NodarDavituri/fast-compact
claude plugin install fast-compact@fast-compact
```

Restart Claude Code (or `/reload-plugins`) and type `/fc`. The key can also go in the plugin's own `apiKey` option (`/plugin configure fast-compact`), which Claude Code keeps in secure storage.

## Options

Set with `/plugin configure fast-compact`, or under `pluginConfigs` in `settings.json`.

| Option | Default | |
|---|---|---|
| `provider` | `openrouter` | `openrouter` (key in `OPENROUTER_API_KEY`) or `typesafe` (`TYPESAFE_API_KEY`) |
| `apiKey` | — | the key, instead of the environment |
| `baseUrl` | the provider's | another System One endpoint |
| `model` | `jev-latest` | the model name sent |
| `keepRecentCalls` | `10` | the newest tool calls never cut |
| `cutTo` | `1500` | characters a cut keeps: two thirds from the start, one third from the end |
| `keepWhole` | `0.25` | at most this share of the old outputs' characters stays whole on Jev's ranking |
| `minKeepScore` | `0.45` | Jev's score below which an output is never kept whole |
| `cutInputs` | `true` | cut long old tool inputs too |
| `sendSamples` | `true` | show Jev the first 200 and last 100 characters of each output it ranks |
| `resumeSafe` | `true` | hand messages back as new ones, so `--resume` keeps the compaction |

## What leaves your machine, and what stays

Each `/fc` sends Jev the conversation so far — your and Claude's text (long texts abridged), tool inputs (truncated), a one-line note per tool output, and, with `sendSamples`, the first 200 and last 100 characters of each output it ranks — plus one question per output. Credential-shaped strings (API keys, tokens, `PASSWORD=…`, URLs with passwords, private keys) are masked before sending; the masking is by pattern, so treat it as a safety net, not a guarantee. Nothing is sent when no key is set.

The full text of every cut goes to `~/.claude/fast-compact/<session>/`, next to where Claude Code already keeps your transcripts, and one line per `/fc` to `~/.claude/fast-compact/ledger-<year>-<month>.jsonl` (sizes, counts, cost). Nothing is deleted automatically; `find ~/.claude/fast-compact -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -r {} +` clears sessions older than a month.

## Limits

- Function hooks are early access: a Claude Code update can change them. If `/fc` stops answering, check `claude plugin validate` and the plugin's `hooks module … loaded` line in a `--debug-file` log.
- The transcript shows `/compact [fast-compact]`: `/fc` runs Claude Code's own `/compact` as its vehicle and this plugin answers that compaction. (Claude Code refuses a compaction started from inside a command's hook, and does not run a plugin's hooks on a compaction the plugin started itself.)
- Only tool output, tool input and host notices are cut. A conversation that is mostly text shrinks with `/compact`, not `/fc`.
- With `resumeSafe`, older messages lose hidden reasoning, and a message that held only an image or only hidden reasoning is dropped; text and tool calls stay.
- Jev gets up to six seconds per request inside the hook's ten-second budget; a slower or silent endpoint means the newest outputs stay whole for that run instead.
- Any main-conversation compaction whose instructions start with `[fast-compact]` is this plugin's — including a `/compact [fast-compact]` you type yourself.
- Cuts are measured in characters, not tokens.
- The bench is one person's sessions, with a proxy label checked on 100 outputs by model readers. Run it on your own: `bun bench/run.ts --jev`.

## Development

```sh
bun install
bun run types        # writes Claude Code's plugin API types into .claude/types
bun run typecheck
bun run test         # core (bun test) and the plugin in Claude Code's own test host
bun run validate
```

`src/` is the logic (no Node, no dependencies: a hooks module runs in its own environment), `hooks/fast-compact.ts` the Claude Code side, `tests/core` and `tests/plugin` the tests, `bench/` the replay bench.

## Credits

Built on [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) (MIT) — the idea, the staged fitting of the conversation into Jev's state (`src/state.ts`), and the library itself, kept under `bench/upstream/` so the bench can measure it; its unmerged `bash-output-trim` branch first saved what compaction drops to a file. Findings and ideas from that repository's issues and pull requests shaped this one: #26 (yelban), #52 (grigorelipcanu, Austin666k, JYeswak), #56 (0xsline), #99 (Dymyt-ry) and #57 (u2giants) measured the scoring; #65 and #77/#78 (orangewk) the invented reports and host text; #67 (hyofeng) and #83 (grahamfarrar) keeping calls; #81 (davekim917) and #85 (kuishou68) token estimates; #89 (federicodeponte) and #98 (socialadsmentor) resume; #97 (grixu) the firewall; #103 (XavierXIEXIN) no summary fallback; #105 (prasannaJosium) samples inside questions; #107 (jayjeo) which compactions to touch; #20 (Manojbhat09) a separate command.

## License

MIT.
