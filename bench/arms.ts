/**
 * The methods being compared. Each turns a point into one score per
 * candidate (higher = keep first); upstream as shipped also yields its own
 * keep / truncate / drop decisions.
 */
import { batchCalls, decideCall, questionsFor } from './upstream/compact.js';
import { collectToolCalls, estimateTokens, fitState, truncate } from './upstream/state.js';
import type { CallAction, ToolCall } from './upstream/types.js';
import { ask } from './jev.js';
import type { Point } from './points.js';
import type { BenchMessage } from './transcript.js';

export type Scores = Map<string, number>;

export interface JevRun {
  scores: Scores;
  cost: number;
  inputTokens: number;
  requests: number;
  cached: number;
  stage: string;
  model: string;
}

const PRESERVE = 6;
const MAX_STATE = 25_000;

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) / 2 ** 32;
}

export function baselineScores(point: Point): Record<string, Scores> {
  const of = (f: (c: Point['candidates'][number]) => number): Scores =>
    new Map(point.candidates.map((c) => [c.tool_use_id, f(c)]));
  return {
    random: of((c) => hash(c.tool_use_id)),
    newest: of((c) => c.callIndex),
    largest: of((c) => c.resultChars),
    smallest: of((c) => -c.resultChars),
    errors_then_newest: of((c) => (c.isError ? 1e9 : 0) + c.callIndex),
  };
}

function toolCalls(point: Point): ToolCall[] {
  return collectToolCalls(point.history, PRESERVE);
}

function resultOf(history: readonly BenchMessage[], call: ToolCall): string {
  return (
    history[call.resultIndex]?.toolResults?.find((r) => r.tool_use_id === call.tool_use_id)?.text ?? ''
  );
}

/** Upstream as shipped: its state, its two questions, its 0.5 threshold. */
export async function upstreamJev(
  point: Point,
): Promise<JevRun & { keepCall: Scores; actions: Map<string, CallAction> }> {
  const calls = toolCalls(point);
  const unpinned = calls.filter((c) => !c.pinned);
  const fitted = fitState(point.history, calls, {
    maxStateTokens: MAX_STATE,
    preserveRecentMessages: PRESERVE,
    goal: '',
  });
  const batches = batchCalls(unpinned, fitted.tokens, { maxRequestTokens: 30_000 }).map((batch) =>
    Object.assign({}, ...batch.map(questionsFor)),
  );
  const answer = await ask(`${point.id}-j0`, fitted.state, batches);
  const scores: Scores = new Map();
  const keepCall: Scores = new Map();
  const actions = new Map<string, CallAction>();
  for (const call of unpinned) {
    const keepResult = answer.answers[`result_${call.id}`]?.noul;
    const call_ = answer.answers[`call_${call.id}`]?.noul;
    if (typeof keepResult !== 'number' || typeof call_ !== 'number') {
      throw new Error(`${point.id}: no upstream answer for ${call.id}`);
    }
    scores.set(call.tool_use_id, keepResult);
    keepCall.set(call.tool_use_id, call_);
    actions.set(
      call.tool_use_id,
      decideCall(call, { keepResult, keepCall: call_ }, { keepThreshold: 0.5 }).action,
    );
  }
  return { ...runOf(answer, scores, fitted.stage), keepCall, actions };
}

const CONTEXT =
  'A coding assistant conversation is being compacted to free context. `history` is the conversation so far, oldest first; each tool call\'s output is replaced by a short `result` note and long texts may be abridged. Each question asks about one tool output: whether the assistant will need something from it again. An output that is not needed is cut from the history.';

/** The last three prompts a person wrote, leaving out what the host wrote. */
export function goalOf(history: readonly BenchMessage[]): string {
  return history
    .filter(
      (m) => m.role === 'user' && !m.host && m.text.trim().length > 0 && !(m.toolResults?.length),
    )
    .slice(-3)
    .map((m) => truncate(m.text, 500))
    .join('\n');
}

function sampleOf(text: string, head = 200, tail = 100): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= head + tail + 20) return flat;
  return `${flat.slice(0, head)} […] ${flat.slice(-tail)}`;
}

function neededQuestion(call: ToolCall, sample: string | undefined): Record<string, unknown> {
  const question = `The output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) holds something the assistant will need again to continue the work in \`goal\`: a value, identifier, path, error message or file content that a later step will read, cite or act on.`;
  return {
    type: 'noul',
    instructions: sample === undefined ? question : { output_sample: sample, question },
    criteria: {
      true: 'The output carries details the ongoing work still depends on and has not been restated since: the content of a file still being edited, an error still being fixed, values, IDs or paths a later step will use, a list the assistant is still working through.',
      false: 'The output is spent or incidental: listings and searches whose findings were already acted on or restated in the conversation, confirmation that a command succeeded, content of a file that was rewritten since, output unrelated to the current work.',
    },
  };
}

/** Reworded question with criteria, optionally carrying a sample of the output. */
export async function neededJev(point: Point, withSample: boolean): Promise<JevRun> {
  const calls = toolCalls(point);
  const byUse = new Map(calls.map((c) => [c.tool_use_id, c]));
  const fitted = fitState(point.history, calls, {
    maxStateTokens: MAX_STATE,
    preserveRecentMessages: PRESERVE,
    goal: goalOf(point.history),
  });
  const state = { ...fitted.state, context: CONTEXT };
  const budget = 60_000 - fitted.tokens - 50;
  const batches: Record<string, unknown>[] = [];
  let current: Record<string, unknown> = {};
  let used = 0;
  for (const candidate of point.candidates) {
    const call = byUse.get(candidate.tool_use_id)!;
    const q = neededQuestion(
      call,
      withSample ? sampleOf(resultOf(point.history, call)) : undefined,
    );
    const tokens = estimateTokens(JSON.stringify(q)) + 5;
    if (used + tokens > budget && used > 0) {
      batches.push(current);
      current = {};
      used = 0;
    }
    current[`need_${call.id}`] = q;
    used += tokens;
  }
  if (used > 0) batches.push(current);
  const answer = await ask(`${point.id}-${withSample ? 'j1' : 'j1ns'}`, state, batches);
  const scores: Scores = new Map();
  for (const candidate of point.candidates) {
    const call = byUse.get(candidate.tool_use_id)!;
    const p = answer.answers[`need_${call.id}`]?.noul;
    if (typeof p !== 'number') throw new Error(`${point.id}: no answer for ${call.id}`);
    scores.set(candidate.tool_use_id, p);
  }
  return runOf(answer, scores, fitted.stage);
}

function runOf(
  answer: Awaited<ReturnType<typeof ask>>,
  scores: Scores,
  stage: string,
): JevRun {
  return {
    scores,
    cost: answer.cost,
    inputTokens: answer.inputTokens,
    requests: answer.requests,
    cached: answer.cached,
    stage,
    model: answer.model,
  };
}

/**
 * The plugin as shipped: its state and question (src/), asked about every
 * candidate so the ranking compares with the other arms.
 */
export async function pluginJev(point: Point): Promise<JevRun> {
  const { collectCalls, fitState: fitPlugin } = await import('../src/state.js');
  const { batchQuestions, neededQuestion } = await import('../src/jev.js');
  const { protectedFrom } = await import('../src/compact.js');
  const { DEFAULT_OPTIONS } = await import('../src/types.js');
  const history = point.history as unknown as import('../src/types.js').Message[];
  const calls = collectCalls(history);
  const byUse = new Map(calls.map((c) => [c.tool_use_id, c]));
  const fitted = fitPlugin(history, calls, {
    maxTokens: DEFAULT_OPTIONS.maxStateTokens,
    pinnedFrom: protectedFrom(history, DEFAULT_OPTIONS.keepRecentCalls),
  });
  const questions = new Map(
    point.candidates.map((c) => [`need_${byUse.get(c.tool_use_id)!.id}`, neededQuestion(byUse.get(c.tool_use_id)!, true)]),
  );
  const batches = batchQuestions(questions, fitted.tokens, DEFAULT_OPTIONS.maxRequestTokens);
  const answer = await ask(`${point.id}-plugin`, fitted.state, batches as Record<string, unknown>[]);
  const scores: Scores = new Map();
  for (const c of point.candidates) {
    const p = answer.answers[`need_${byUse.get(c.tool_use_id)!.id}`]?.noul;
    if (typeof p !== 'number') throw new Error(`${point.id}: no plugin answer for ${c.tool_use_id}`);
    scores.set(c.tool_use_id, p);
  }
  return runOf(answer, scores, fitted.stage);
}
