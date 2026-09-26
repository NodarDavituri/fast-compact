/**
 * Asking Jev for the bench: OpenRouter's System One endpoint (TypeSafe's with
 * JEV_BASE_URL / a TypeSafe key), credential-shaped strings masked before
 * anything is sent, answers cached on disk by request hash so a rerun costs
 * nothing, oversized requests split in half and retried.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Answers {
  answers: Record<string, { noul?: number }>;
  inputTokens: number;
  cost: number;
  model: string;
  requests: number;
  cached: number;
}

const BASE_URL = process.env.JEV_BASE_URL ?? 'https://openrouter.ai/api/v1/systemone';
const MODEL = process.env.JEV_MODEL ?? 'jev-1.13';
const CACHE = new URL('./.cache/jev/', import.meta.url).pathname;

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g,
  /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi,
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY)[A-Z0-9_]*\s*[=:]\s*)["']?[^\s"']{6,}/gi,
];

/** Masks credential-shaped strings; returns the text and how many were masked. */
export function redact(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, keep?: string) => {
      count++;
      const tail = match.endsWith('@') ? '@' : '';
      return typeof keep === 'string' && match.startsWith(keep) ? `${keep}[REDACTED]${tail}` : '[REDACTED]';
    });
  }
  return { text: out, count };
}

let limiterActive = 0;
const limiterQueue: (() => void)[] = [];
async function limited<T>(fn: () => Promise<T>, max = 4): Promise<T> {
  if (limiterActive >= max) await new Promise<void>((resolve) => limiterQueue.push(resolve));
  limiterActive++;
  try {
    return await fn();
  } finally {
    limiterActive--;
    limiterQueue.shift()?.();
  }
}

export let redactedTotal = 0;

async function post(body: string): Promise<{ status: number; text: string }> {
  const key = process.env.OPENROUTER_API_KEY ?? process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY or TYPESAFE_API_KEY is not set');
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(BASE_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(60_000),
    }).catch((error: unknown) => ({ status: 0, text: async () => String(error) }));
    const text = await response.text();
    const retryable = response.status === 0 || response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= 3) return { status: response.status, text };
    await Bun.sleep(1000 * 3 ** attempt);
  }
}

/**
 * Asks one state a set of questions, in batches that are split in half when
 * the endpoint says a request is too large. Throws on any other failure.
 */
export async function ask(
  cacheKey: string,
  state: object,
  batches: Record<string, unknown>[],
): Promise<Answers> {
  const total: Answers = { answers: {}, inputTokens: 0, cost: 0, model: '', requests: 0, cached: 0 };
  const run = async (questions: Record<string, unknown>): Promise<void> => {
    // Masked per string, never over the JSON text, where a mask could swallow an
    // escape; and well-formed, since a cut can split a surrogate pair and the
    // endpoint rejects the lone half as malformed JSON.
    const body = JSON.stringify({ model: MODEL, state, questions }, (_, v: unknown) => {
      if (typeof v !== 'string') return v;
      const r = redact(v.toWellFormed());
      redactedTotal += r.count;
      return r.text;
    });
    const masked = { text: body };
    const hash = createHash('sha256').update(masked.text).digest('hex').slice(0, 16);
    const file = `${CACHE}${cacheKey}-${hash}.json`;
    let parsed: { answers?: Answers['answers']; usage?: { input_tokens?: number; cost?: number }; model?: string };
    if (existsSync(file)) {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
      total.cached++;
    } else {
      const { status, text } = await limited(() => post(masked.text));
      if (status === 400 && text.includes('max_tokens') && Object.keys(questions).length > 1) {
        const names = Object.keys(questions);
        const half = Math.ceil(names.length / 2);
        await run(Object.fromEntries(names.slice(0, half).map((n) => [n, questions[n]])));
        await run(Object.fromEntries(names.slice(half).map((n) => [n, questions[n]])));
        return;
      }
      if (status !== 200) throw new Error(`Jev ${status}: ${text.slice(0, 200)}`);
      parsed = JSON.parse(text);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(parsed));
    }
    total.requests++;
    Object.assign(total.answers, parsed.answers ?? {});
    total.inputTokens += parsed.usage?.input_tokens ?? 0;
    total.cost += parsed.usage?.cost ?? 0;
    total.model = parsed.model ?? total.model;
  };
  await Promise.all(batches.map(run));
  return total;
}
