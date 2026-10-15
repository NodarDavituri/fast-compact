# Changelog

What changed in each version, and anything you need to do when you update. Update with `claude plugin marketplace update fast-compact && claude plugin update fast-compact@fast-compact`, then restart Claude Code or run `/reload-plugins`.

## 0.3.0 — 2026-10-15

### New

- `provider: none` — never ask Jev, even when a key is in your environment. `/fc` keeps the newest old outputs whole instead, and nothing leaves your machine. In the replay bench that keeps 73% of later-needed outputs usable against Jev's 75%.
- The `prompt` meter's line is shorter and shows the share of the context window `/fc` would free, plus how to hide it on its first three lines in a session: `/fc frees ~30k tokens (3%) · hide: /plugin configure fast-compact → meter`.
- `meter: both` — the line under the prompt and the status-line file together.
- The README's status-line snippet now shows the same share (`/fc −3%`), read from the status line's `context_window.context_window_size`.
- `docs/design.md`: why fast-compact works the way it does, what was turned down, and what's still open.

### Fixed

- A second `/fc` no longer cuts most of what the first kept whole: outputs cut earlier now count in the `keepWhole` budget at their full size, so repeated runs keep the same outputs whole.
- On a Claude Code an organization manages, plugins you install yourself get no compaction hooks, so `/fc` silently got Claude Code's slow summary. fast-compact now says so the first time and turns `/fc` and the meter off for that session.
- With `autoCompact`, Jev is no longer asked when even cutting everything wouldn't free enough; Claude Code summarises straight away.
- With `resumeSafe` off, parallel tool calls could again reach Claude unanswered after a compaction (the bug 0.2.0 fixed). Those calls are now merged as with `resumeSafe` on.
- After one Jev request fails, the others stop sending, retries included.
- The meter reads the transcript only when the context changed, not on every usage update.

### Changed

- `provider` ignores case, takes `off` as `none`, and treats any value it doesn't know as `none`, so a typo never sends your conversation to OpenRouter. The report says when that happened.
- `meter` is a picker in `/config`: `prompt`, `statusline`, `both` or `off`.
- `meter` now defaults to `prompt`: a line under the prompt shows what `/fc` would free once there's at least 2k tokens to free. It sends nothing anywhere. Set `meter` to `off` to hide it; if you set `meter` yourself before, nothing changes for you.
- The `prompt` meter's line reads differently (shorter, with the window share and a hint). If you matched on its old text, update the pattern.
- The meter file for `statusline` is unchanged: still the token count. To show a percentage, replace the README snippet you copied with the new one.

## 0.2.0

- `autoCompact`: auto-compaction is cut the way `/fc` cuts when that frees enough, and summarised by Claude Code otherwise (off by default).
- `meter`: shows what `/fc` would free, under the prompt or in a file for your status line (off by default).
- Fixed: after a compaction, parallel tool calls could reach Claude unanswered ("Tool result missing due to internal error").

Thanks to ggagosh (#1).

## 0.1.0

- `/fast-compact` and `/fc` beside Claude Code's own `/compact`: old tool output cut to its start and end, Jev choosing what stays whole, every cut saved to a file.
