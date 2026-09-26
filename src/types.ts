/**
 * The message shape a `session.compact` hook receives (a subset of Claude
 * Code's `SessionMessage`): one message per content block, tool calls on the
 * assistant side, their outputs on the user side, and the engine's `handle`
 * on every message it handed over.
 */
export interface ToolUse {
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  /** The output as the model read it, once the transcript holds it. */
  text?: string;
  isError?: true;
  result?: unknown;
}

export interface ToolResult {
  tool_use_id: string;
  text: string;
  isError: boolean;
  result?: unknown;
}

export interface Message {
  role: 'user' | 'assistant';
  text: string;
  toolUses: ToolUse[];
  toolResults?: ToolResult[];
  /** The engine's token for a message it handed over; absent on one built here. */
  handle?: string;
}

export interface Options {
  /** The newest tool calls whose inputs and outputs are never cut. */
  keepRecentCalls: number;
  /** Characters a cut output or input field keeps: two thirds from its start, one third from its end. */
  cutTo: number;
  /** Characters a cut host notice keeps from its start. */
  noticeCutTo: number;
  /** At most this share of the old outputs' characters is kept whole on Jev's say. */
  keepWhole: number;
  /** Jev's probability below which an output is never kept whole. */
  minKeepScore: number;
  /** Cut long tool inputs (Bash scripts, Write bodies, Edit strings) too. */
  cutInputs: boolean;
  /** Send Jev the start and end of each output it judges. */
  sendSamples: boolean;
  /** Hand every message back without its handle, so --resume keeps the compaction. */
  resumeSafe: boolean;
  /** Estimated token ceilings for the Jev state and for one request. */
  maxStateTokens: number;
  maxRequestTokens: number;
}

export const DEFAULT_OPTIONS: Options = {
  keepRecentCalls: 10,
  cutTo: 1500,
  noticeCutTo: 300,
  keepWhole: 0.25,
  minKeepScore: 0.45,
  cutInputs: true,
  sendSamples: true,
  resumeSafe: true,
  maxStateTokens: 25_000,
  maxRequestTokens: 60_000,
};

export type CutKind = 'output' | 'input' | 'notice';

/** One thing a compaction cuts, and where its full text goes. */
export interface Cut {
  kind: CutKind;
  /** Stable name for the archive file: the tool_use_id (plus the input field) or the message index. */
  key: string;
  /** Index of the message holding it. */
  index: number;
  tool_use_id?: string;
  /** The input field cut, for `input`. */
  field?: string;
  tool?: string;
  original: string;
}

/** One question's answer: Jev's probability that the output will be needed again. */
export type Scores = ReadonlyMap<string, number>;

/** Answers the questions over one state, in whatever batches the transport needs. */
export interface Asker {
  ask(state: object, questions: Record<string, object>): Promise<Record<string, number>>;
}
