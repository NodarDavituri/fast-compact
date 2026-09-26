/**
 * What a method's scores are worth.
 *
 * Ranking: AUC of the scores against the *needed* label (0.5 = a coin flip).
 *
 * Budget: every candidate result is cut to a stub (the first 200 and last 100
 * characters) unless the method keeps it whole; the method keeps results in
 * its own order while the total stays under a fraction of the candidates'
 * characters. `head_tail` instead cuts every result to that same fraction
 * (70% from the start, 30% from the end). Recall is the share of the tokens
 * the window used that survive the cut, and the share of needed results that
 * keep at least one of them.
 */
import type { CallAction } from '../src/types.js';
import type { Scores } from './arms.js';
import type { Candidate } from './points.js';

export const STUB_HEAD = 200;
export const STUB_TAIL = 100;

export function auc(scores: readonly number[], labels: readonly boolean[]): number | undefined {
  const pairs = scores.map((s, i) => ({ s, y: labels[i]! })).sort((a, b) => a.s - b.s);
  const pos = pairs.filter((p) => p.y).length;
  const neg = pairs.length - pos;
  if (pos === 0 || neg === 0) return undefined;
  let rankSum = 0;
  for (let i = 0; i < pairs.length; ) {
    let j = i;
    while (j < pairs.length && pairs[j]!.s === pairs[i]!.s) j++;
    const rank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) if (pairs[k]!.y) rankSum += rank;
    i = j;
  }
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

export interface Tally {
  keptChars: number;
  totalChars: number;
  tokensKept: number;
  tokensTotal: number;
  neededKept: number;
  neededTotal: number;
}

export function emptyTally(): Tally {
  return { keptChars: 0, totalChars: 0, tokensKept: 0, tokensTotal: 0, neededKept: 0, neededTotal: 0 };
}

export function addTally(into: Tally, from: Tally): Tally {
  for (const key of Object.keys(into) as (keyof Tally)[]) into[key] += from[key];
  return into;
}

type Window = (length: number) => { head: number; tail: number } | 'whole';

function tally(candidates: readonly Candidate[], windowOf: (c: Candidate) => ReturnType<Window>): Tally {
  const t = emptyTally();
  for (const c of candidates) {
    const window = windowOf(c);
    t.totalChars += c.resultChars;
    t.keptChars += window === 'whole' ? c.resultChars : Math.min(c.resultChars, window.head + window.tail);
    let any = false;
    for (const { token, offsets } of c.neededTokens) {
      const kept =
        window === 'whole' ||
        offsets.some(
          (o) => o + token.length <= window.head || o >= c.resultChars - window.tail,
        );
      t.tokensTotal++;
      if (kept) {
        t.tokensKept++;
        any = true;
      }
    }
    if (c.needed) {
      t.neededTotal++;
      if (any) t.neededKept++;
    }
  }
  return t;
}

/** The results a method keeps whole within `fraction` of the characters, every other one a stub. */
export function wholeSet(candidates: readonly Candidate[], scores: Scores, fraction: number): Set<string> {
  const total = candidates.reduce((sum, c) => sum + c.resultChars, 0);
  const stub = (c: Candidate): number => Math.min(c.resultChars, STUB_HEAD + STUB_TAIL);
  let left = fraction * total - candidates.reduce((sum, c) => sum + stub(c), 0);
  const whole = new Set<string>();
  const order = [...candidates].sort(
    (a, b) => (scores.get(b.tool_use_id) ?? 0) - (scores.get(a.tool_use_id) ?? 0),
  );
  for (const c of order) {
    const extra = c.resultChars - stub(c);
    if (extra <= left) {
      whole.add(c.tool_use_id);
      left -= extra;
    }
  }
  return whole;
}

/** Keeps whole results in score order within `fraction` of the characters; the rest become stubs. */
export function budgeted(candidates: readonly Candidate[], scores: Scores, fraction: number): Tally {
  const total = candidates.reduce((sum, c) => sum + c.resultChars, 0);
  const stub = (c: Candidate): number => Math.min(c.resultChars, STUB_HEAD + STUB_TAIL);
  let left = fraction * total - candidates.reduce((sum, c) => sum + stub(c), 0);
  const whole = new Set<string>();
  const order = [...candidates].sort(
    (a, b) => (scores.get(b.tool_use_id) ?? 0) - (scores.get(a.tool_use_id) ?? 0),
  );
  for (const c of order) {
    const extra = c.resultChars - stub(c);
    if (extra <= left) {
      whole.add(c.tool_use_id);
      left -= extra;
    }
  }
  return tally(candidates, (c) =>
    whole.has(c.tool_use_id) ? 'whole' : { head: STUB_HEAD, tail: STUB_TAIL },
  );
}

export function headTail(candidates: readonly Candidate[], fraction: number): Tally {
  return tally(candidates, (c) => {
    const keep = Math.floor(fraction * c.resultChars);
    return { head: Math.floor(keep * 0.7), tail: keep - Math.floor(keep * 0.7) };
  });
}

/**
 * head_tail with the cut tilted by a score: each result keeps
 * `min(1, λ·w)` of itself, `w` its score over the mean score, `λ` found so
 * the total is `fraction` of the characters. Equal scores give head_tail.
 */
export function tilted(candidates: readonly Candidate[], scores: Scores, fraction: number): Tally {
  const raw = candidates.map((c) => Math.max(1e-6, scores.get(c.tool_use_id) ?? 0));
  const mean = raw.reduce((a, b) => a + b, 0) / raw.length;
  const weights = raw.map((s) => s / mean);
  const total = candidates.reduce((sum, c) => sum + c.resultChars, 0);
  const size = (lambda: number): number =>
    candidates.reduce((sum, c, i) => sum + Math.min(1, lambda * weights[i]!) * c.resultChars, 0);
  let lo = 0;
  let hi = 1;
  while (size(hi) < fraction * total && hi < 1e6) hi *= 2;
  for (let step = 0; step < 50; step++) {
    const mid = (lo + hi) / 2;
    if (size(mid) < fraction * total) lo = mid;
    else hi = mid;
  }
  const keepOf = new Map(candidates.map((c, i) => [c.tool_use_id, Math.min(1, lo * weights[i]!)]));
  return tally(candidates, (c) => {
    const share = keepOf.get(c.tool_use_id)!;
    if (share >= 1) return 'whole';
    const keep = Math.floor(share * c.resultChars);
    return { head: Math.floor(keep * 0.7), tail: keep - Math.floor(keep * 0.7) };
  });
}

/** Upstream's own decisions: keep whole, truncate to a 300-char head, or drop call and result. */
export function upstreamDecisions(
  candidates: readonly Candidate[],
  actions: ReadonlyMap<string, CallAction>,
): Tally {
  return tally(candidates, (c) => {
    const action = actions.get(c.tool_use_id) ?? 'keep';
    if (action === 'keep') return 'whole';
    if (action === 'drop_result') return { head: c.resultChars <= 420 ? c.resultChars : 300, tail: 0 };
    return { head: 0, tail: 0 };
  });
}

export function recall(t: Tally): { tokens: number; results: number; size: number } {
  return {
    tokens: t.tokensTotal ? t.tokensKept / t.tokensTotal : NaN,
    results: t.neededTotal ? t.neededKept / t.neededTotal : NaN,
    size: t.totalChars ? t.keptChars / t.totalChars : NaN,
  };
}

/** Every result cut to at most `chars` characters (70% from the start, 30% from the end). */
export function fixedCut(candidates: readonly Candidate[], chars: number): Tally {
  return tally(candidates, (c) =>
    c.resultChars <= chars ? 'whole' : { head: Math.floor(chars * 0.7), tail: chars - Math.floor(chars * 0.7) },
  );
}
