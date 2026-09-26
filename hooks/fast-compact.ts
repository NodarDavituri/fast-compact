/**
 * The Claude Code side of fast-compact: `/fast-compact` (and `/fc`) cut old
 * tool output down to its start and end, with Jev choosing which outputs stay
 * whole, and save everything cut to a file named in its place. Claude Code's
 * own `/compact` and auto-compaction are left alone: this module's
 * `session.compact` hook acts only on the compaction its own command asked
 * for, and never hands one to the built-in summary.
 */
import type { PluginOptions, Register } from 'claude-code';
import { applyCuts, decide, fresh, sizeOf, type Decision, type JevAccess } from '../src/compact.js';
import { DEFAULT_MODEL, ENDPOINTS, type Provider } from '../src/jev.js';
import { DEFAULT_OPTIONS, type Cut, type Message, type Options } from '../src/types.js';

interface Settings {
  options: Options;
  provider: Provider;
  url: string;
  model: string;
  apiKey?: string;
}

function numberOption(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function booleanOption(options: PluginOptions, key: string, fallback: boolean): boolean {
  const value = options[key];
  return typeof value === 'boolean' ? value : fallback;
}

function stringOption(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function settingsOf(options: PluginOptions): Settings {
  const provider: Provider = stringOption(options, 'provider') === 'typesafe' ? 'typesafe' : 'openrouter';
  const d = DEFAULT_OPTIONS;
  return {
    provider,
    url: stringOption(options, 'baseUrl') ?? ENDPOINTS[provider],
    model: stringOption(options, 'model') ?? DEFAULT_MODEL,
    apiKey: stringOption(options, 'apiKey'),
    options: {
      ...d,
      keepRecentCalls: Math.max(0, Math.floor(numberOption(options, 'keepRecentCalls', d.keepRecentCalls))),
      cutTo: Math.max(200, Math.floor(numberOption(options, 'cutTo', d.cutTo))),
      keepWhole: Math.min(1, Math.max(0, numberOption(options, 'keepWhole', d.keepWhole))),
      minKeepScore: Math.min(1, Math.max(0, numberOption(options, 'minKeepScore', d.minKeepScore))),
      cutInputs: booleanOption(options, 'cutInputs', d.cutInputs),
      sendSamples: booleanOption(options, 'sendSamples', d.sendSamples),
      resumeSafe: booleanOption(options, 'resumeSafe', d.resumeSafe),
    },
  };
}

function pct(part: number, whole: number): string {
  return whole === 0 ? '0%' : `${Math.round((100 * part) / whole)}%`;
}

function kchars(n: number): string {
  return n >= 10_000 ? `${Math.round(n / 1000)}k` : `${(n / 1000).toFixed(1)}k`;
}

/** The one-line account the person sees under the command. */
export function reportOf(decision: Decision, before: number, after: number, cuts: readonly Cut[], dir: string): string {
  const count = (kind: Cut['kind']): number => cuts.filter((c) => c.kind === kind).length;
  const parts = [
    `${count('output')} outputs cut`,
    decision.whole.size > 0
      ? `${decision.whole.size} kept whole ${decision.ranking === 'jev' ? 'on Jev’s ranking' : 'as the newest'}`
      : '',
    count('input') > 0 ? `${count('input')} inputs cut` : '',
    count('notice') > 0 ? `${count('notice')} notices cut` : '',
  ].filter(Boolean);
  const jev = decision.jev
    ? `Jev ${decision.jev.model || 'answered'}: ${decision.jev.requests} request${decision.jev.requests === 1 ? '' : 's'}, ${(decision.jev.ms / 1000).toFixed(1)} s, $${decision.jev.cost.toFixed(4)}`
    : `no Jev (${decision.jevSkipped ?? 'not asked'}), newest kept whole`;
  return `${kchars(before)} → ${kchars(after)} chars (−${pct(before - after, before)}); ${parts.join(', ')}; ${jev}. Full text of every cut: ${dir}/`;
}

/**
 * The instructions the scheduled `/compact` carries. A main-conversation
 * compaction whose instructions start with it is this plugin's, whatever else
 * is pending: it is answered here, never handed to the built-in summary.
 */
export const MARKER = '[fast-compact]';

export function markerOf(focus: string): string {
  return focus ? `${MARKER} ${focus}` : MARKER;
}

/** The focus a marked compaction carries ('' for none), or undefined for one that is not marked. */
export function focusOf(instructions: string | undefined): string | undefined {
  const text = instructions?.trimStart() ?? '';
  return text.startsWith(MARKER) ? text.slice(MARKER.length).trim() : undefined;
}

/** A /fc whose /compact has not settled holds off another; one stuck this long is let go. */
const STUCK_MS = 120_000;
/** The longest one Jev request may wait, and what is kept back of the hook's 10 s budget. */
const JEV_WAIT_MS = 6_000;
const BUDGET_RESERVE_MS = 2_500;
/** Characters per archive file: at most 3 MB of UTF-8 whatever the text (the host refuses writes over 4 MiB). */
const PART_CHARS = 1_000_000;

/** `text` in pieces of at most `size` characters, never splitting a surrogate pair. */
function parts(text: string, size: number): string[] {
  const out: string[] = [];
  for (let at = 0; at < text.length; ) {
    let end = Math.min(text.length, at + size);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    out.push(text.slice(at, end));
    at = end;
  }
  return out.length > 0 ? out : [''];
}

export const register: Register = (on, options) => {
  const settings = settingsOf(options);
  /** The /fc whose scheduled /compact has not settled yet. */
  let running: { at: number } | undefined;
  /** What the last compaction did, logged once the /compact it rode on has finished (a log line written during a compaction is lost with the screen). */
  let report: string | undefined;

  on('session.start', async ($, e, next) => {
    const started = await next(e);
    await $.command.register({
      name: 'fast-compact',
      description: 'Cut old tool output to its start and end (Jev keeps what is still needed); /compact is untouched',
      argumentHint: '[what to keep]',
    });
    await $.command.register({
      name: 'fc',
      description: 'fast-compact: cut old tool output, Jev keeps what is still needed',
      argumentHint: '[what to keep]',
    });
    return started;
  });

  // The host refuses a compaction started inside a command's own hook (the
  // command holds the turn) and skips this plugin's hooks on one it starts
  // itself, so the command schedules Claude Code's own /compact, marked, for
  // the moment after it returns; the session.compact hook below answers it.
  on('command.run', async ($, e, next) => {
    if (e.command !== 'fast-compact' && e.command !== 'fc') return next(e);
    const now = await $.clock.now();
    if (running && now - running.at < STUCK_MS) return { text: 'a compaction is already running' };
    const focus = e.args.trim();
    const mine = { at: now };
    running = mine;
    report = undefined;
    $.clock.after(0, () => {
      $.command
        .run({ command: 'compact', args: markerOf(focus) })
        .then(() => {
          $.ui.log(report ?? 'the compaction did not reach this plugin; nothing was cut');
        })
        .catch((error: unknown) => {
          $.ui.log(`could not compact (${error instanceof Error ? error.message : String(error)})`);
        })
        .finally(() => {
          report = undefined;
          if (running === mine) running = undefined;
        });
    });
    return { text: `compacting${focus ? ` (keeping: ${focus})` : ''}…` };
  });

  on('session.compact', async ($, e, next) => {
    // Ours is the main conversation's manual or plugin compaction carrying the
    // marker (the scheduled /compact arrives as `manual` in 2.1.283); auto,
    // precompute and subagent compactions, and every unmarked one, pass on.
    const mainManual = !e.agentId && (e.trigger === 'plugin' || e.trigger === 'manual');
    const focus = mainManual ? focusOf(e.instructions) : undefined;
    if (focus === undefined) return next(e);
    const messages = e.messages as readonly Message[];
    // $.clock.sleep counts against the hook's 10 s budget ($.http.fetch does
    // not), so Jev's waits are sized from what is left, keeping a reserve for
    // the archive writes; running short only means ranking newest first.
    const left = (): number => next.budget.remainingMs;

    const home = (await $.env.get('HOME')) ?? '';
    const sessionId = await $.session.id();
    const dir = `${home}/.claude/fast-compact/${sessionId}`;
    const now = new Date(await $.clock.now()).toISOString();
    const stamp = now.replace(/[-:]/g, '').slice(0, 15);

    let apiKey = settings.apiKey;
    if (!apiKey) {
      apiKey =
        settings.provider === 'typesafe'
          ? await $.env.get('TYPESAFE_API_KEY')
          : await $.env.get('OPENROUTER_API_KEY');
    }
    if (!apiKey) {
      const env = (await $.settings.read())['env'];
      const name = settings.provider === 'typesafe' ? 'TYPESAFE_API_KEY' : 'OPENROUTER_API_KEY';
      const value = env && typeof env === 'object' ? (env as Record<string, unknown>)[name] : undefined;
      if (typeof value === 'string' && value) apiKey = value;
    }
    const jev: JevAccess | undefined = apiKey
      ? {
          config: { url: settings.url, apiKey, model: settings.model },
          now: () => $.clock.now(),
          transport: {
            post: async (url, headers, body) => {
              const wait = Math.min(JEV_WAIT_MS, left() - BUDGET_RESERVE_MS);
              if (wait < 1000) throw new Error('no time left in the hook budget');
              const stop = new AbortController();
              const timedOut = { status: 0, text: '' };
              try {
                const answer = await Promise.race([
                  $.http.fetch(url, { method: 'POST', headers, body }).then((r) => ({ status: r.status, text: r.text })),
                  $.clock.sleep(wait, { signal: stop.signal }).then(
                    () => timedOut,
                    () => timedOut,
                  ),
                ]);
                if (answer === timedOut) throw new Error(`no answer in ${(wait / 1000).toFixed(1)} s`);
                return answer;
              } finally {
                stop.abort();
              }
            },
            sleep: (ms) => $.clock.sleep(Math.max(0, Math.min(ms, left() - BUDGET_RESERVE_MS - 1000))),
          },
        }
      : undefined;

    const decision = await decide(messages, settings.options, jev, focus || undefined);
    if (decision.cuts.length === 0) {
      const why = `nothing old enough and long enough to cut (the newest ${settings.options.keepRecentCalls} tool calls are kept as they are)`;
      report = why;
      return { skip: why };
    }

    // A key carries a tool_use_id and, for an input, the field name (an MCP
    // tool's own): only safe characters reach the file name.
    const pathOf = (cut: Cut): string =>
      `${dir}/${cut.kind}-${(cut.kind === 'notice' ? `${stamp}-${cut.key}` : cut.key).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_')}.txt`;
    const partsOf = new Map<Cut, number>();
    const whereOf = (cut: Cut): string => {
      const n = partsOf.get(cut) ?? 1;
      return n > 1 ? `${pathOf(cut)} (continued in .part2 to .part${n} beside it)` : pathOf(cut);
    };
    const saved: Cut[] = [];
    await Promise.all(
      decision.cuts.map(async (cut) => {
        try {
          const pieces = parts(cut.original, PART_CHARS);
          for (const [i, piece] of pieces.entries()) {
            await $.fs.write(i === 0 ? pathOf(cut) : `${pathOf(cut)}.part${i + 1}`, piece);
          }
          partsOf.set(cut, pieces.length);
          saved.push(cut);
        } catch {
          // not saved, so not cut; counted in the report
        }
      }),
    );
    const unsaved = decision.cuts.length - saved.length;
    if (saved.length === 0) {
      report = `nothing cut: none of the ${unsaved} full texts could be saved under ${dir}/`;
      return { skip: 'the full texts could not be saved' };
    }

    const cut = applyCuts(messages, saved, whereOf, settings.options);
    const compacted = settings.options.resumeSafe ? fresh(cut) : cut;
    const before = sizeOf(messages);
    const after = sizeOf(compacted);
    report = reportOf(decision, before, after, saved, dir) + (unsaved > 0 ? ` ${unsaved} left uncut: their full text could not be saved.` : '');

    // One ledger per month keeps each file far below the host's 4 MiB read limit.
    const ledger = `${home}/.claude/fast-compact/ledger-${now.slice(0, 7)}.jsonl`;
    const line = JSON.stringify({
      at: now,
      session: sessionId,
      before,
      after,
      outputs: saved.filter((c) => c.kind === 'output').length,
      inputs: saved.filter((c) => c.kind === 'input').length,
      notices: saved.filter((c) => c.kind === 'notice').length,
      unsaved,
      whole: decision.whole.size,
      ranking: decision.ranking,
      jev: decision.jev
        ? { model: decision.jev.model, requests: decision.jev.requests, ms: decision.jev.ms, cost: decision.jev.cost, stage: decision.jev.stage, redacted: decision.jev.redacted }
        : { skipped: decision.jevSkipped },
      provider: settings.provider,
    });
    try {
      const previous = (await $.fs.exists(ledger)) ? await $.fs.read(ledger) : '';
      await $.fs.write(ledger, `${previous}${line}\n`);
    } catch {
      // the ledger is a convenience; a compaction never fails over it
    }
    return { messages: compacted };
  }).catch((_$, _e, next) => {
    // A failure on this plugin's own compaction answers a skip, never the
    // built-in summary; one on a compaction it passed on stands as it was.
    if (next.called) return undefined;
    const why = `failed (${next.error.kind}${next.error.message ? `: ${next.error.message}` : ''}); nothing was cut`;
    report = why;
    return { skip: `fast-compact ${why}` };
  });
};
