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

const JEV_TIMEOUT_MS = 30_000;
const WRITE_LIMIT = 3_500_000;

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
 * The instructions the scheduled `/compact` carries: how this plugin knows its
 * own request, and, should its hook not run, what the built-in summary is told.
 */
export const MARKER = '[fast-compact]';
export function markerOf(focus: string): string {
  return focus ? `${MARKER} ${focus}` : MARKER;
}

/** How long a request from the command waits for its compaction before it lapses. */
const REQUEST_TTL_MS = 60_000;

export const register: Register = (on, options) => {
  const settings = settingsOf(options);
  /**
   * Set by the command for the compaction it schedules; only that compaction
   * is this plugin's, and a request that never arrives lapses.
   */
  let requested: { focus: string; at: number } | undefined;
  /** The account of the last compaction, logged once the /compact it rode on has finished. */
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
  // command holds the turn), so the command schedules it for the moment after
  // it returns, and the compaction reports in the transcript when it is done.
  on('command.run', async ($, e, next) => {
    if (e.command !== 'fast-compact' && e.command !== 'fc') return next(e);
    const now = await $.clock.now();
    if (requested && now - requested.at < REQUEST_TTL_MS) {
      return { text: 'a compaction is already on its way' };
    }
    const focus = e.args.trim();
    requested = { focus, at: now };
    $.clock.after(0, () => {
      $.command
        .run({ command: 'compact', args: markerOf(focus) })
        .then(() => {
          if (report) $.ui.log(report);
          else if (requested) $.ui.log('the compaction did not reach this plugin; nothing was cut');
          report = undefined;
        })
        .catch((error: unknown) => {
          $.ui.log(`could not compact (${error instanceof Error ? error.message : String(error)})`);
        })
        .finally(() => {
          requested = undefined;
        });
    });
    return { text: `compacting${focus ? ` (keeping: ${focus})` : ''}…` };
  });

  on('session.compact', async ($, e, next) => {
    // The compaction the command scheduled arrives as `plugin` or, in 2.1.283,
    // as `manual`; it is recognised by the pending request and its instructions,
    // never by the trigger alone, and auto, precompute and subagents never are.
    const pending = requested;
    const ours =
      pending !== undefined &&
      (e.trigger === 'plugin' || e.trigger === 'manual') &&
      !e.agentId &&
      (e.instructions ?? '') === markerOf(pending.focus);
    if (!ours || !pending) return next(e);
    requested = undefined;
    if ((await $.clock.now()) - pending.at > REQUEST_TTL_MS) return next(e);
    const focus = pending.focus;
    const messages = e.messages as readonly Message[];

    const home = (await $.env.get('HOME')) ?? '';
    const sessionId = await $.session.id();
    const dir = `${home}/.claude/fast-compact/${sessionId}`;
    const stamp = new Date(await $.clock.now()).toISOString().replace(/[-:]/g, '').slice(0, 15);

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
              const timedOut = { status: 0, text: 'timed out' };
              const answer = await Promise.race([
                $.http.fetch(url, { method: 'POST', headers, body }).then((r) => ({ status: r.status, text: r.text })),
                $.clock.sleep(JEV_TIMEOUT_MS).then(() => timedOut),
              ]);
              if (answer === timedOut) throw new Error(`no answer in ${JEV_TIMEOUT_MS / 1000} s`);
              return answer;
            },
            sleep: (ms) => $.clock.sleep(ms),
          },
        }
      : undefined;

    const decision = await decide(messages, settings.options, jev, focus || undefined);
    if (decision.cuts.length === 0) {
      const why = `nothing old enough and long enough to cut (the newest ${settings.options.keepRecentCalls} tool calls are kept as they are)`;
      $.ui.log(`${why}`);
      return { skip: why };
    }

    // A key carries a tool_use_id and, for an input, the field name (an MCP tool's own):
    // only safe characters reach the file name.
    const pathOf = (cut: Cut): string =>
      `${dir}/${cut.kind}-${(cut.kind === 'notice' ? `${stamp}-${cut.key}` : cut.key).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_')}.txt`;
    const saved: Cut[] = [];
    await Promise.all(
      decision.cuts.map(async (cut) => {
        try {
          const path = pathOf(cut);
          if (cut.original.length <= WRITE_LIMIT) await $.fs.write(path, cut.original);
          else {
            for (let part = 0, at = 0; at < cut.original.length; part++, at += WRITE_LIMIT) {
              await $.fs.write(part === 0 ? path : `${path}.part${part + 1}`, cut.original.slice(at, at + WRITE_LIMIT));
            }
          }
          saved.push(cut);
        } catch (error) {
          $.ui.log(`not cut, could not save ${cut.key} to ${pathOf(cut)}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
    );
    if (saved.length === 0) {
      $.ui.log('nothing cut — none of the full texts could be saved');
      return { skip: 'the full texts could not be saved' };
    }

    const cut = applyCuts(messages, saved, pathOf, settings.options);
    const compacted = settings.options.resumeSafe ? fresh(cut) : cut;
    const before = sizeOf(messages);
    const after = sizeOf(compacted);
    report = reportOf(decision, before, after, saved, dir);

    const ledger = `${home}/.claude/fast-compact/ledger.jsonl`;
    const line = JSON.stringify({
      at: new Date(await $.clock.now()).toISOString(),
      session: sessionId,
      before,
      after,
      outputs: saved.filter((c) => c.kind === 'output').length,
      inputs: saved.filter((c) => c.kind === 'input').length,
      notices: saved.filter((c) => c.kind === 'notice').length,
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
    // A failure on this plugin's own compaction answers a skip, never the built-in summary.
    if (next.called) return undefined;
    return { skip: `fast-compact failed: ${String(next.error)}` };
  });
};
