/**
 * What a fast compaction cuts, and the conversation after it.
 *
 * Old tool outputs longer than `cutTo` keep their start and end, unless Jev
 * ranks them among the outputs the assistant will need again (then they stay
 * whole, within `keepWhole` of the old outputs' characters). Long old tool
 * inputs and host notices are cut by rule. The newest `keepRecentCalls` calls
 * and every word a person or the assistant wrote stay as they are. Nothing is
 * cut without its full text being saved first (the caller archives, then
 * applies), and a call is never removed: the transcript keeps its shape.
 */
import { askAll, batchQuestions, type Answered, type JevConfig, neededQuestion, type Transport } from './jev.js';
import { collectCalls, fitState, type Call } from './state.js';
import { cutEnd, cutMiddle, isHostText, wasCut } from './text.js';
import type { Cut, Message, Options, ToolResult, ToolUse } from './types.js';

export interface Plan {
  /** Index of the first message that is never cut. */
  protectedFrom: number;
  calls: Call[];
  outputs: Call[];
  inputs: { call: Call; field: string; text: string }[];
  notices: { index: number; text: string }[];
}

function slack(cutTo: number): number {
  return Math.ceil(cutTo * 1.3);
}

/** The index of the message holding the `keep`-th newest tool call (0 when there are fewer). */
export function protectedFrom(messages: readonly Message[], keep: number): number {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    seen += messages[i]!.toolUses.length;
    if (seen >= keep) return i;
  }
  return 0;
}

export function plan(messages: readonly Message[], options: Options): Plan {
  const from = protectedFrom(messages, options.keepRecentCalls);
  const calls = collectCalls(messages);
  const old = calls.filter((c) => c.callIndex < from && c.resultIndex < from);
  const outputs = old.filter((c) => c.output.length > slack(options.cutTo) && !wasCut(c.output));
  const inputs: Plan['inputs'] = [];
  if (options.cutInputs) {
    for (const call of old) {
      for (const [field, value] of Object.entries(call.input)) {
        if (typeof value === 'string' && value.length > slack(options.cutTo) && !wasCut(value)) {
          inputs.push({ call, field, text: value });
        }
      }
    }
  }
  const notices: Plan['notices'] = [];
  messages.forEach((m, index) => {
    if (index === 0 || index >= from || m.role !== 'user' || m.toolResults?.length) return;
    if (isHostText(m.text) && m.text.length > options.noticeCutTo * 2 && !wasCut(m.text)) {
      notices.push({ index, text: m.text });
    }
  });
  return { protectedFrom: from, calls, outputs, inputs, notices };
}

export type Ranking = 'jev' | 'newest';

/**
 * The outputs kept whole: in Jev's order (only those at or above
 * `minKeepScore`), or newest first without Jev, while the characters kept
 * beyond the cut stay within `keepWhole` of the old outputs' total.
 */
export function chooseWhole(
  outputs: readonly Call[],
  scores: ReadonlyMap<string, number> | undefined,
  options: Options,
): Set<string> {
  const total = outputs.reduce((n, c) => n + c.output.length, 0);
  let left = options.keepWhole * total;
  const order = scores
    ? outputs
        .filter((c) => (scores.get(c.tool_use_id) ?? 0) >= options.minKeepScore)
        .sort((a, b) => scores.get(b.tool_use_id)! - scores.get(a.tool_use_id)!)
    : [...outputs].sort((a, b) => b.callIndex - a.callIndex);
  const whole = new Set<string>();
  for (const call of order) {
    const extra = call.output.length - options.cutTo;
    if (extra <= left) {
      whole.add(call.tool_use_id);
      left -= extra;
    }
  }
  return whole;
}

export function cutsOf(p: Plan, whole: ReadonlySet<string>): Cut[] {
  return [
    ...p.outputs
      .filter((c) => !whole.has(c.tool_use_id))
      .map((c): Cut => ({ kind: 'output', key: c.tool_use_id, index: c.resultIndex, tool_use_id: c.tool_use_id, tool: c.tool, original: c.output })),
    ...p.inputs.map(({ call, field, text }): Cut => ({
      kind: 'input',
      key: `${call.tool_use_id}-${field}`,
      index: call.callIndex,
      tool_use_id: call.tool_use_id,
      field,
      tool: call.tool,
      original: text,
    })),
    ...p.notices.map(({ index, text }): Cut => ({ kind: 'notice', key: `m${index}`, index, original: text })),
  ];
}

export interface Decision {
  plan: Plan;
  whole: Set<string>;
  ranking: Ranking;
  cuts: Cut[];
  jev?: Answered & { stage: string; ms: number };
  /** Why Jev was not used, when it was not. */
  jevSkipped?: string;
}

export interface JevAccess {
  transport: Transport;
  config: JevConfig;
  now(): Promise<number>;
}

/**
 * Plans the cut and, when there are outputs to rank and Jev is reachable,
 * asks it which to keep whole. Jev failing never fails the compaction: the
 * outputs are ranked newest first instead, and `jevSkipped` says why.
 */
export async function decide(
  messages: readonly Message[],
  options: Options,
  jev: JevAccess | undefined,
  focus?: string,
): Promise<Decision> {
  const p = plan(messages, options);
  let scores: Map<string, number> | undefined;
  let jevRun: Decision['jev'];
  let jevSkipped: string | undefined;
  if (p.outputs.length === 0) jevSkipped = 'no old outputs to rank';
  else if (!jev) jevSkipped = 'no Jev key';
  else {
    try {
      const started = await jev.now();
      const fitted = fitState(messages, p.calls, {
        maxTokens: options.maxStateTokens,
        pinnedFrom: p.protectedFrom,
        focus,
      });
      const questions = new Map(p.outputs.map((c) => [`need_${c.id}`, neededQuestion(c, options.sendSamples)]));
      const batches = batchQuestions(questions, fitted.tokens, options.maxRequestTokens);
      const answered = await askAll(jev.transport, jev.config, fitted.state, batches);
      scores = new Map(p.outputs.map((c) => [c.tool_use_id, answered.scores.get(`need_${c.id}`)!]));
      jevRun = { ...answered, stage: fitted.stage, ms: (await jev.now()) - started };
    } catch (error) {
      jevSkipped = error instanceof Error ? error.message : String(error);
    }
  }
  const whole = chooseWhole(p.outputs, scores, options);
  return {
    plan: p,
    whole,
    ranking: scores ? 'jev' : 'newest',
    cuts: cutsOf(p, whole),
    jev: jevRun,
    jevSkipped,
  };
}

/**
 * The conversation handed back as messages the engine writes afresh: without
 * their handles, so a resumed session loads the compacted form (with a handle
 * kept, the loader walks back past the compaction to the full history:
 * anthropics/claude-code#95328, upstream #89). A message left with nothing to
 * write (a thinking block) is dropped; hidden reasoning and images do not
 * survive, text and tool calls do.
 */
export function fresh(messages: readonly Message[]): Message[] {
  return messages
    .map(({ handle: _handle, ...m }) => m)
    .filter((m) => m.text.length > 0 || m.toolUses.length > 0 || (m.toolResults?.length ?? 0) > 0);
}

/** Characters of text, tool inputs and outputs, the measure of what a compaction freed. */
export function sizeOf(messages: readonly Message[]): number {
  let n = 0;
  for (const m of messages) {
    n += m.text.length;
    for (const u of m.toolUses) n += JSON.stringify(u.input).length;
    for (const r of m.toolResults ?? []) n += r.text.length;
  }
  return n;
}

/**
 * The conversation with `cuts` applied, each marker naming `pathOf(cut)`.
 * Only a message that changes is rebuilt (and so loses the engine's handle);
 * every other message is returned as the object it came in as.
 */
export function applyCuts(
  messages: readonly Message[],
  cuts: readonly Cut[],
  pathOf: (cut: Cut) => string,
  options: Options,
): Message[] {
  const outputs = new Map<string, Cut>();
  const inputs = new Map<string, Cut[]>();
  const notices = new Map<number, Cut>();
  for (const cut of cuts) {
    if (cut.kind === 'output') outputs.set(cut.tool_use_id!, cut);
    else if (cut.kind === 'input') inputs.set(cut.tool_use_id!, [...(inputs.get(cut.tool_use_id!) ?? []), cut]);
    else notices.set(cut.index, cut);
  }
  return messages.map((m, index) => {
    const notice = notices.get(index);
    if (notice) {
      return { role: m.role, text: cutEnd(m.text, options.noticeCutTo, pathOf(notice)), toolUses: [] };
    }
    if (m.toolResults?.some((r) => outputs.has(r.tool_use_id))) {
      const toolResults = m.toolResults.map((r): ToolResult => {
        const cut = outputs.get(r.tool_use_id);
        return cut
          ? { tool_use_id: r.tool_use_id, text: cutMiddle(r.text, options.cutTo, pathOf(cut), 'this output'), isError: r.isError }
          : r;
      });
      return { role: m.role, text: m.text, toolUses: m.toolUses, toolResults };
    }
    if (m.toolUses.some((u) => inputs.has(u.tool_use_id))) {
      const toolUses = m.toolUses.map((u): ToolUse => {
        const own = inputs.get(u.tool_use_id);
        if (!own) return u;
        const input = { ...u.input };
        for (const cut of own) {
          input[cut.field!] = cutMiddle(cut.original, options.cutTo, pathOf(cut), `this ${cut.field} field`);
        }
        const rebuilt: ToolUse = { tool_use_id: u.tool_use_id, tool: u.tool, input };
        const outputCut = outputs.get(u.tool_use_id);
        if (u.text !== undefined) {
          rebuilt.text = outputCut ? cutMiddle(u.text, options.cutTo, pathOf(outputCut), 'this output') : u.text;
        }
        if (u.isError) rebuilt.isError = true;
        return rebuilt;
      });
      return { role: m.role, text: m.text, toolUses };
    }
    return m;
  });
}
