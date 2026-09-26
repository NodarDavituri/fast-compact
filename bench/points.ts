/**
 * Replay points and their labels.
 *
 * A point is a moment in a segment where the context passed a size threshold
 * and the session then made at least `windowCalls` more tool calls without
 * compacting: what came next was done with the whole history in view, so it
 * shows what the history was needed for.
 *
 * A candidate is a tool result before the point, outside the pinned first and
 * newest messages, at least `minResultChars` long. It is labelled *needed*
 * when a distinctive token it introduced (a path, a number, or an identifier
 * with a digit or underscore, 8+ characters; the definition from upstream
 * #99) is used by the assistant — in its text or a tool input — within the
 * window, with three exclusions that keep the label honest:
 *   - the token appeared before the result (the result did not introduce it);
 *   - it appeared again anywhere between the result and the point (the
 *     history still carries it without this result, e.g. the assistant
 *     already wrote it in its own words — the circularity #99 warns about);
 *   - in the window, a tool result or a user message carried it before the
 *     assistant used it (the use did not depend on the history).
 */
import { collectToolCalls } from '../src/state.js';
import { type BenchMessage, listTranscripts, readSegments, type Segment } from './transcript.js';

export const TOKEN_RE = /[A-Za-z0-9_][A-Za-z0-9_./~@:#+-]{6,}[A-Za-z0-9_]/g;

export function distinctiveTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const [token] of text.matchAll(TOKEN_RE)) {
    const path = token.includes('/');
    const number = /^\d+$/.test(token);
    const identifier = /[A-Za-z]/.test(token) && /[\d_]/.test(token);
    if (path || number || identifier) tokens.add(token);
  }
  return tokens;
}

type Channel = 'agent' | 'result' | 'user';

interface Occurrence {
  index: number;
  channel: Channel;
}

function inputJson(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input);
  } catch {
    return '';
  }
}

/** Where every distinctive token occurs in a segment, in message order. */
function occurrences(messages: readonly BenchMessage[]): Map<string, Occurrence[]> {
  const map = new Map<string, Occurrence[]>();
  const add = (text: string, index: number, channel: Channel): void => {
    for (const token of distinctiveTokens(text)) {
      const list = map.get(token) ?? [];
      list.push({ index, channel });
      map.set(token, list);
    }
  };
  messages.forEach((message, index) => {
    if (message.role === 'assistant') {
      add(message.text, index, 'agent');
      for (const tool of message.toolUses) add(inputJson(tool.input), index, 'agent');
    } else {
      add(message.text, index, 'user');
      for (const result of message.toolResults ?? []) add(result.text, index, 'result');
    }
  });
  return map;
}

export interface Candidate {
  tool_use_id: string;
  tool: string;
  /** Message index of the call and of its result. */
  callIndex: number;
  resultIndex: number;
  resultChars: number;
  isError: boolean;
  /** The tokens the window used from this result, with their offsets in it. */
  neededTokens: { token: string; offsets: number[] }[];
  needed: boolean;
}

export interface Point {
  id: string;
  session: string;
  project: string;
  /** Messages before the point: what the compaction would run over. */
  history: BenchMessage[];
  /** The messages the window covers: the work done after the point. */
  window: BenchMessage[];
  contextTokens: number;
  candidates: Candidate[];
}

export interface PointOptions {
  thresholds: number[];
  windowCalls: number;
  preserveRecentMessages: number;
  minResultChars: number;
}

export const DEFAULT_POINT_OPTIONS: PointOptions = {
  thresholds: [100_000, 200_000, 300_000, 450_000, 600_000, 800_000],
  windowCalls: 40,
  preserveRecentMessages: 6,
  minResultChars: 500,
};

function offsetsOf(text: string, token: string): number[] {
  const offsets: number[] = [];
  for (let at = text.indexOf(token); at !== -1; at = text.indexOf(token, at + 1)) offsets.push(at);
  return offsets;
}

function windowEnd(messages: readonly BenchMessage[], from: number, calls: number): number | undefined {
  let seen = 0;
  for (let i = from; i < messages.length; i++) {
    seen += messages[i]!.toolUses.length;
    if (seen >= calls) return i + 1;
  }
  return undefined;
}

export function pointsOf(segment: Segment, options: PointOptions = DEFAULT_POINT_OPTIONS): Point[] {
  const { messages } = segment;
  const occ = occurrences(messages);
  const points: Point[] = [];
  let next = 0;
  messages.forEach((message, at) => {
    const threshold = options.thresholds[next];
    if (threshold === undefined || message.role !== 'assistant') return;
    if ((message.contextTokens ?? 0) < threshold) return;
    while ((options.thresholds[next] ?? Infinity) <= (message.contextTokens ?? 0)) next++;
    const end = windowEnd(messages, at, options.windowCalls);
    if (end === undefined) return;
    const history = messages.slice(0, at);
    const calls = collectToolCalls(history, options.preserveRecentMessages);
    const candidates: Candidate[] = [];
    for (const call of calls) {
      if (call.pinned || call.resultChars < options.minResultChars) continue;
      const result = history[call.resultIndex]!.toolResults!.find(
        (r) => r.tool_use_id === call.tool_use_id,
      )!;
      const neededTokens: Candidate['neededTokens'] = [];
      for (const token of distinctiveTokens(result.text)) {
        const list = occ.get(token)!;
        if (list[0]!.index !== call.resultIndex) continue;
        if (list.some((o) => o.index > call.resultIndex && o.index < at)) continue;
        const first = list.find((o) => o.index >= at && o.index < end);
        if (first?.channel === 'agent') {
          neededTokens.push({ token, offsets: offsetsOf(result.text, token) });
        }
      }
      candidates.push({
        tool_use_id: call.tool_use_id,
        tool: call.tool,
        callIndex: call.callIndex,
        resultIndex: call.resultIndex,
        resultChars: call.resultChars,
        isError: call.isError,
        neededTokens,
        needed: neededTokens.length > 0,
      });
    }
    points.push({
      id: `${segment.session.slice(0, 8)}-s${segment.index}-m${at}`,
      session: segment.session,
      project: segment.project,
      history,
      window: messages.slice(at, end),
      contextTokens: message.contextTokens ?? 0,
      candidates,
    });
  });
  return points;
}

const MIN_CANDIDATES = 10;
const PER_SESSION = 3;
const PER_PROJECT = 12;

export function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Every point in the transcripts under `root`, and a spread sample of `n`:
 * points with at least 10 candidates, at most three per session (the
 * smallest, middle and largest context) and twelve per project, taken
 * round-robin across projects in a fixed pseudo-random order.
 */
export function loadSample(
  root: string,
  n: number,
  quietMs?: number,
): { all: number; points: Point[]; every: Point[] } {
  const all: Point[] = [];
  for (const { path, project } of listTranscripts(root, quietMs)) {
    for (const segment of readSegments(path, project)) all.push(...pointsOf(segment));
  }
  const bySession = new Map<string, Point[]>();
  for (const p of all) {
    if (p.candidates.length < MIN_CANDIDATES) continue;
    bySession.set(p.session, [...(bySession.get(p.session) ?? []), p]);
  }
  const byProject = new Map<string, Point[]>();
  for (const points of bySession.values()) {
    const sorted = points.sort((a, b) => a.contextTokens - b.contextTokens);
    const picked =
      sorted.length <= PER_SESSION
        ? sorted
        : [sorted[0]!, sorted[Math.floor(sorted.length / 2)]!, sorted[sorted.length - 1]!];
    for (const p of picked) byProject.set(p.project, [...(byProject.get(p.project) ?? []), p]);
  }
  const queues = [...byProject.values()].map((points) =>
    points.sort((a, b) => hash(a.id) - hash(b.id)).slice(0, PER_PROJECT),
  );
  const chosen: Point[] = [];
  for (let round = 0; chosen.length < n && queues.some((q) => q.length > round); round++) {
    for (const q of queues) if (q[round] && chosen.length < n) chosen.push(q[round]!);
  }
  return { all: all.length, points: chosen, every: all };
}
