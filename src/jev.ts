/**
 * Asking Jev (TypeSafe's System One model) which old tool outputs the
 * assistant will need again. One `noul` question per output, the whole
 * fitted conversation as the shared state, batches under the request limit,
 * sent concurrently through whatever transport the host provides.
 */
import { requestJson } from './redact.js';
import { estimateTokens, type Call } from './state.js';
import { sample } from './text.js';

export type Provider = 'openrouter' | 'typesafe';

export const ENDPOINTS: Record<Provider, string> = {
  openrouter: 'https://openrouter.ai/api/v1/systemone',
  typesafe: 'https://api.typesafe.ai/v1/systemone',
};

export const DEFAULT_MODEL = 'jev-latest';

/** 32k tokens for the state plus the longest question (docs.typesafe.ai/models). */
export const STATE_PLUS_QUESTION_LIMIT = 32_000;

export interface Transport {
  post(url: string, headers: Record<string, string>, body: string): Promise<{ status: number; text: string }>;
  sleep(ms: number): Promise<void>;
}

export interface JevConfig {
  url: string;
  apiKey: string;
  model: string;
  concurrency?: number;
  retries?: number;
}

export type JevErrorKind = 'auth' | 'blocked' | 'too_large' | 'rate' | 'server' | 'transport' | 'malformed';

export class JevError extends Error {
  constructor(
    message: string,
    readonly kind: JevErrorKind,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface Answered {
  scores: Map<string, number>;
  requests: number;
  inputTokens: number;
  cost: number;
  model: string;
  redacted: number;
}

const CRITERIA = {
  true: 'The output carries details the ongoing work still depends on and has not been restated since: the content of a file still being edited, an error still being fixed, values, IDs or paths a later step will use, a list the assistant is still working through.',
  false: 'The output is spent or incidental: listings and searches whose findings were already acted on or restated in the conversation, confirmation that a command succeeded, content of a file that was rewritten since, output unrelated to the current work.',
};

/** The question about one output; its sample rides in the question, not the shared state. */
export function neededQuestion(call: Call, withSample: boolean): object {
  const question = `The output of tool call ${call.id} (${call.tool}, ${call.output.length} chars) holds something the assistant will need again to continue the work in \`goal\`: a value, identifier, path, error message or file content that a later step will read, cite or act on.`;
  return {
    type: 'noul',
    instructions: withSample ? { output_sample: sample(call.output), question } : question,
    criteria: CRITERIA,
  };
}

/** Splits questions into batches whose state plus questions fit one request. */
export function batchQuestions(
  questions: ReadonlyMap<string, object>,
  stateTokens: number,
  maxRequestTokens: number,
): Record<string, object>[] {
  const budget = maxRequestTokens - stateTokens - 50;
  const batches: Record<string, object>[] = [];
  let current: Record<string, object> = {};
  let used = 0;
  for (const [name, q] of questions) {
    const tokens = estimateTokens(JSON.stringify(q)) + 5;
    if (stateTokens + tokens > STATE_PLUS_QUESTION_LIMIT || tokens > budget) {
      throw new JevError(`a question does not fit beside the state (~${stateTokens} tokens)`, 'too_large');
    }
    if (used + tokens > budget && used > 0) {
      batches.push(current);
      current = {};
      used = 0;
    }
    current[name] = q;
    used += tokens;
  }
  if (used > 0) batches.push(current);
  return batches;
}

/** Reads one response; throws a JevError that says what went wrong. */
export function parseResponse(
  status: number,
  text: string,
  names: readonly string[],
): { answers: Record<string, number>; model: string; inputTokens: number; cost: number } {
  if (status !== 200) {
    const html = /^\s*</.test(text);
    if (status === 403 && html) {
      throw new JevError(
        'the endpoint refused the request with an HTML page (HTTP 403) — a web firewall in front of it, not the key; the openrouter provider avoids it',
        'blocked',
        status,
      );
    }
    if (status === 401 || status === 403) throw new JevError(`the key was refused (HTTP ${status})`, 'auth', status);
    if (status === 400 && text.includes('max_tokens')) throw new JevError('the request was too large', 'too_large', status);
    if (status === 429) throw new JevError('rate limited (HTTP 429)', 'rate', status);
    if (status >= 500 || status === 0) throw new JevError(`the endpoint failed (HTTP ${status})`, 'server', status);
    throw new JevError(`HTTP ${status}: ${text.slice(0, 160)}`, 'malformed', status);
  }
  let parsed: {
    answers?: Record<string, { noul?: unknown }>;
    model?: string;
    usage?: { input_tokens?: number; cost?: number };
  };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new JevError('the response is not JSON', 'malformed', status);
  }
  const answers: Record<string, number> = {};
  for (const name of names) {
    const p = parsed.answers?.[name]?.noul;
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) {
      throw new JevError(`no valid answer for ${name}`, 'malformed', status);
    }
    answers[name] = p;
  }
  return {
    answers,
    model: parsed.model ?? '',
    inputTokens: parsed.usage?.input_tokens ?? 0,
    cost: parsed.usage?.cost ?? 0,
  };
}

/**
 * Asks every batch, at most `concurrency` at a time. A batch the endpoint
 * finds too large is split in half; a rate limit or server failure is retried
 * with a growing pause; anything else fails the whole request.
 */
export async function askAll(
  transport: Transport,
  config: JevConfig,
  state: object,
  batches: readonly Record<string, object>[],
): Promise<Answered> {
  const out: Answered = { scores: new Map(), requests: 0, inputTokens: 0, cost: 0, model: '', redacted: 0 };
  const retries = config.retries ?? 2;
  // Once one batch has failed the answer is lost anyway: the others send nothing more, retries included.
  let failed = false;
  const one = async (questions: Record<string, object>): Promise<void> => {
    const names = Object.keys(questions);
    const { body, redacted } = requestJson({ model: config.model, state, questions });
    for (let attempt = 0; ; attempt++) {
      if (failed) return;
      let response: { status: number; text: string };
      try {
        response = await transport.post(
          config.url,
          { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
          body,
        );
      } catch (error) {
        if (attempt < retries) {
          await transport.sleep(300 * 3 ** attempt);
          continue;
        }
        throw new JevError(`the request failed: ${error instanceof Error ? error.message : String(error)}`, 'transport');
      }
      try {
        const parsed = parseResponse(response.status, response.text, names);
        out.requests++;
        out.redacted += redacted;
        out.inputTokens += parsed.inputTokens;
        out.cost += parsed.cost;
        out.model = parsed.model || out.model;
        for (const [name, p] of Object.entries(parsed.answers)) out.scores.set(name, p);
        return;
      } catch (error) {
        if (!(error instanceof JevError)) throw error;
        if (error.kind === 'too_large' && names.length > 1) {
          const half = Math.ceil(names.length / 2);
          const pick = (list: string[]): Record<string, object> =>
            Object.fromEntries(list.map((n) => [n, questions[n]!]));
          await one(pick(names.slice(0, half)));
          await one(pick(names.slice(half)));
          return;
        }
        if ((error.kind === 'rate' || error.kind === 'server') && attempt < retries) {
          await transport.sleep(300 * 3 ** attempt);
          continue;
        }
        throw error;
      }
    }
  };
  const queue = [...batches];
  const workers = Array.from({ length: Math.min(config.concurrency ?? 4, queue.length) }, async () => {
    for (let next = queue.shift(); next && !failed; next = queue.shift()) {
      try {
        await one(next);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  });
  await Promise.all(workers);
  return out;
}
