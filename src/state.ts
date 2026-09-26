/**
 * The conversation as Jev sees it: every message in order, each tool output
 * replaced by a one-line note, shrunk in stages until it fits the token
 * budget. The staged fitting is adapted from tamaratran/fast-jev-compaction
 * (MIT); the question context, the goal, host notices and the token estimate
 * are this plugin's.
 */
import { isHostText, truncate, wasCut } from './text.js';
import type { Message } from './types.js';

export const STATE_CONTEXT =
  "A coding assistant's conversation is being compacted to free context. `history` is the conversation so far, oldest first; each tool call's output is replaced by a short `result` note, and long texts may be abridged. `goal` is what the person asked for most recently; `focus`, when present, is what they asked this compaction to keep. Each question asks about one tool output: whether the assistant will need something from it again. An output that is not needed keeps only its start and end.";

/** A tool call paired with its output, with the short id the state and questions use. */
export interface Call {
  id: string;
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  callIndex: number;
  resultIndex: number;
  output: string;
  isError: boolean;
}

export interface HistoryEntry {
  i: number;
  role: 'user' | 'assistant';
  text: string;
  tool_calls?: { id: string; tool: string; input: string; result: string }[] | string[];
}

export interface JevState {
  context: string;
  goal: string;
  focus?: string;
  history: HistoryEntry[];
}

export interface FittedState {
  state: JevState;
  tokens: number;
  stage: string;
}

const PIECES = /[A-Za-z0-9]+|[^\sA-Za-z0-9]/g;
const VOWELS = /[aeiouAEIOU]/g;

function wordCost(run: string): number {
  let cost = 0;
  for (const [piece] of run.matchAll(/[A-Za-z]+|\d+/g)) {
    cost += /\d/.test(piece[0]!) ? piece.length / 2 : 1 + Math.floor((piece.length - 1) / 6);
  }
  return cost;
}

/**
 * Tokens without a tokenizer: a word one per six letters, a digit half, any
 * other character about one. A run that is not made of words — letters mixed
 * with digits (hashes, UUIDs), or a long vowel-starved run (base64) — costs
 * at least one token per three characters, which a word estimate undercounts
 * (upstream #81/#85).
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const [piece] of text.matchAll(PIECES)) {
    const code = piece.charCodeAt(0);
    const alnum = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    if (!alnum) {
      tokens += code < 128 ? 0.9 : 1.1;
      continue;
    }
    let cost = wordCost(piece);
    const mixed = /[A-Za-z]/.test(piece) && /\d/.test(piece);
    const dense =
      piece.length >= 16 &&
      (piece.match(VOWELS)?.length ?? 0) / piece.length < 0.25 &&
      new Set(piece).size >= 8;
    if (mixed || dense) cost = Math.max(cost, piece.length / 3);
    tokens += cost;
  }
  return Math.ceil(tokens);
}

/** Pairs every tool call with its output; a call still waiting for one is left out. */
export function collectCalls(messages: readonly Message[]): Call[] {
  const outputs = new Map<string, { index: number; text: string; isError: boolean }>();
  messages.forEach((message, index) => {
    for (const r of message.toolResults ?? []) {
      outputs.set(r.tool_use_id, { index, text: r.text, isError: r.isError });
    }
  });
  const calls: Call[] = [];
  messages.forEach((message, callIndex) => {
    for (const use of message.toolUses) {
      const out = outputs.get(use.tool_use_id);
      if (!out) continue;
      calls.push({
        id: `t${calls.length + 1}`,
        tool_use_id: use.tool_use_id,
        tool: use.tool,
        input: use.input,
        callIndex,
        resultIndex: out.index,
        output: out.text,
        isError: out.isError,
      });
    }
  });
  return calls;
}

/** The last three prompts a person wrote, left out what the host wrote. */
export function goalOf(messages: readonly Message[]): string {
  return messages
    .filter(
      (m) =>
        m.role === 'user' &&
        m.text.trim().length > 0 &&
        !(m.toolResults?.length) &&
        !isHostText(m.text),
    )
    .slice(-3)
    .map((m) => truncate(m.text, 500))
    .join('\n');
}

const INPUT_CHARS = [1000, 200, 60] as const;
const TEXT_HEAD = 400;
const TEXT_TAIL = 150;
const HOST_CHARS = 200;

function inputText(input: Record<string, unknown>, limit: number): string {
  let json: string;
  try {
    json = JSON.stringify(input);
  } catch {
    json = '[unserializable input]';
  }
  return truncate(json, limit);
}

function resultNote(call: Call): string {
  const state = call.isError ? 'error' : 'ok';
  return wasCut(call.output)
    ? `${state}, ${call.output.length} chars left after an earlier cut`
    : `${state}, ${call.output.length} chars (omitted)`;
}

function oneLine(call: Call): string {
  const input = Object.entries(call.input)
    .map(([key, value]) => `${key}=${(typeof value === 'string' ? value : inputText({ [key]: value }, 200)).replace(/\s+/g, ' ')}`)
    .join(' ');
  return `${call.id} ${call.tool} ${truncate(input, INPUT_CHARS[2])} → ${call.isError ? 'error' : 'ok'} ${call.output.length}ch`;
}

function abridge(text: string, head: number, tail: number): string {
  if (text.length <= head + tail + 40) return text;
  return `${text.slice(0, head)}\n[… ${text.length - head - tail} chars omitted …]\n${text.slice(-tail)}`;
}

/**
 * Builds the state and shrinks it in stages until it fits `maxTokens`: tool
 * inputs truncated (1000, 200, 60 chars), long texts abridged oldest first
 * (pinned last), old texts collapsed to a note, old calls reduced to one line
 * each, old call-less entries left out, runs of old call-only entries folded.
 * Entries at `pinnedFrom` and after, and the first, are pinned. Throws when
 * even that does not fit.
 */
export function fitState(
  messages: readonly Message[],
  calls: readonly Call[],
  options: { maxTokens: number; pinnedFrom: number; focus?: string },
): FittedState {
  const goal = goalOf(messages);
  const base: Omit<JevState, 'history'> = { context: STATE_CONTEXT, goal };
  if (options.focus) base.focus = options.focus;
  const stateOf = (history: HistoryEntry[]): JevState => ({ ...base, history });
  const pinned = (i: number): boolean => i === 0 || i >= options.pinnedFrom;
  const byMessage = new Map<number, Call[]>();
  for (const call of calls) byMessage.set(call.callIndex, [...(byMessage.get(call.callIndex) ?? []), call]);

  const entryTokens = (e: HistoryEntry): number => estimateTokens(JSON.stringify(e)) + 1;
  const baseTokens = estimateTokens(JSON.stringify(stateOf([])));
  let history: HistoryEntry[] = [];
  let per: number[] = [];
  let tokens = 0;
  const total = (): number => baseTokens + per.reduce((a, b) => a + b, 0);
  const rebuild = (inputChars: number): void => {
    history = [];
    messages.forEach((m, i) => {
      const own = (byMessage.get(i) ?? []).map((c) => ({
        id: c.id,
        tool: c.tool,
        input: inputText(c.input, inputChars),
        result: resultNote(c),
      }));
      if (m.text.trim().length === 0 && own.length === 0) return;
      const text = m.role === 'user' && isHostText(m.text) ? truncate(m.text, HOST_CHARS) : m.text;
      const entry: HistoryEntry = { i, role: m.role, text };
      if (own.length > 0) entry.tool_calls = own;
      history.push(entry);
    });
    per = history.map(entryTokens);
    tokens = total();
  };
  const fits = (): boolean => tokens <= options.maxTokens;
  const shrink = (k: number, change: (e: HistoryEntry) => void): void => {
    const entry = history[k]!;
    change(entry);
    const now = entryTokens(entry);
    tokens += now - per[k]!;
    per[k] = now;
  };
  const done = (stage: string, h = history): FittedState => ({ state: stateOf(h), tokens, stage });

  rebuild(INPUT_CHARS[0]);
  if (fits()) return done('full');
  for (const limit of INPUT_CHARS.slice(1)) {
    rebuild(limit);
    if (fits()) return done(`inputs<=${limit}`);
  }

  const indices = history.map((_, k) => k);
  const order = [
    ...indices.filter((k) => !pinned(history[k]!.i)),
    ...indices.filter((k) => pinned(history[k]!.i)),
  ];
  for (const k of order) {
    if (history[k]!.text.length <= TEXT_HEAD + TEXT_TAIL + 40) continue;
    shrink(k, (e) => {
      e.text = abridge(e.text, TEXT_HEAD, TEXT_TAIL);
    });
    if (fits()) return done('texts abridged');
  }
  for (const k of order) {
    const e = history[k]!;
    if (pinned(e.i) || e.text.length === 0) continue;
    const length = messages[e.i]!.text.length;
    shrink(k, (x) => {
      x.text = `[… ${length} chars omitted …]`;
    });
    if (fits()) return done('old texts collapsed');
  }
  for (const k of order) {
    const e = history[k]!;
    const own = byMessage.get(e.i);
    if (pinned(e.i) || !own) continue;
    shrink(k, (x) => {
      x.tool_calls = own.map(oneLine);
    });
    if (fits()) return done('old calls one-lined');
  }
  const left = new Set<number>();
  for (const k of order) {
    const e = history[k]!;
    if (pinned(e.i) || e.tool_calls) continue;
    left.add(k);
    tokens -= per[k]!;
    if (fits()) return done('old texts left out', history.filter((_, x) => !left.has(x)));
  }
  const kept = history.filter((_, x) => !left.has(x));
  const folded: HistoryEntry[] = [];
  const foldable = (e: HistoryEntry): boolean =>
    !pinned(e.i) && e.text.length === 0 && typeof e.tool_calls?.[0] === 'string';
  for (const e of kept) {
    const prev = folded[folded.length - 1];
    if (prev && foldable(prev) && foldable(e) && prev.role === e.role) {
      prev.tool_calls = [...(prev.tool_calls as string[]), ...(e.tool_calls as string[])];
    } else folded.push({ ...e });
  }
  history = folded;
  per = history.map(entryTokens);
  tokens = total();
  if (fits()) return done('old calls folded');
  throw new Error(`the history does not fit Jev's state budget (~${tokens} of ${options.maxTokens} tokens)`);
}
