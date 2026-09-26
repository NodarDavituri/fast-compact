import { describe, expect, test } from 'bun:test';
import { askAll, batchQuestions, JevError, parseResponse, type Transport } from '../../src/jev.js';
import { redact, requestJson } from '../../src/redact.js';
import { collectCalls, estimateTokens, fitState, goalOf } from '../../src/state.js';
import { cutMiddle, isHostText, sample, wellFormed } from '../../src/text.js';
import { big, session, user } from './fixtures.js';

describe('text', () => {
  test('wellFormed replaces lone surrogate halves only', () => {
    expect(wellFormed('a😀b')).toBe('a😀b');
    expect(wellFormed('a\ud83d')).toBe('a�');
    expect(wellFormed('\ude00b')).toBe('�b');
  });

  test('a cut never splits a surrogate pair', () => {
    const text = '😀'.repeat(2000);
    const cut = cutMiddle(text, 1501, '/x');
    expect(wellFormed(cut)).toBe(cut);
  });

  test('host text is recognised by its opening', () => {
    expect(isHostText('  <system-reminder>x')).toBe(true);
    expect(isHostText('<local-command-stdout>ok')).toBe(true);
    expect(isHostText('please look at <system-reminder>')).toBe(false);
  });

  test('sample keeps the start and end', () => {
    const s = sample(`${'a'.repeat(500)}${'b'.repeat(500)}`);
    expect(s.startsWith('a'.repeat(200))).toBe(true);
    expect(s.endsWith('b'.repeat(100))).toBe(true);
  });
});

describe('redact', () => {
  test('masks common credential shapes', () => {
    const fake = ['sk', 'or', 'v1', 'x'.repeat(40)].join('-');
    const { text, count } = redact(`key ${fake} and GITHUB_TOKEN=${'g'.repeat(30)} and https://me:${'p'.repeat(12)}@host/x`);
    expect(count).toBe(3);
    expect(text).not.toContain(fake);
    expect(text).toContain('GITHUB_TOKEN=[REDACTED]');
    expect(text).toContain('https://me:[REDACTED]@host/x');
  });

  test('request JSON stays valid when a mask meets an escape', () => {
    const tricky = `TOKEN=abcdefgh\\"} {"x": "PASSWORD: hunter22\\`;
    const { body, redacted } = requestJson({ state: tricky, q: 'a\ud83d' });
    expect(redacted).toBe(2);
    expect(() => JSON.parse(body)).not.toThrow();
    expect(JSON.parse(body).q).toBe('a�');
  });
});

describe('state', () => {
  test('dense runs cost at least a token per three characters', () => {
    const sha = 'e3f262a7f4d42bd8dd32ced30d26176f7cb545b0';
    expect(estimateTokens(sha)).toBeGreaterThanOrEqual(Math.ceil(sha.length / 3));
    expect(estimateTokens('the quick brown fox')).toBeLessThan(8);
  });

  test("the goal is the person's prompts, not the host's", () => {
    const messages = [user('Fix the bug'), user('<system-reminder>ignore</system-reminder>'), user('then ship it')];
    expect(goalOf(messages)).toBe('Fix the bug\nthen ship it');
  });

  test('fits the budget by stages, and says when it cannot', () => {
    const messages = session(60, 10, 3000);
    const calls = collectCalls(messages);
    const roomy = fitState(messages, calls, { maxTokens: 1_000_000, pinnedFrom: messages.length - 20 });
    expect(roomy.stage).toBe('full');
    const tight = fitState(messages, calls, { maxTokens: 3000, pinnedFrom: messages.length - 20 });
    expect(tight.tokens).toBeLessThanOrEqual(3000);
    expect(tight.stage).not.toBe('full');
    expect(() => fitState(messages, calls, { maxTokens: 50, pinnedFrom: 0 })).toThrow('does not fit');
  });

  test('outputs never reach the state, only a note', () => {
    const messages = session(2, 0, 4000);
    const fitted = fitState(messages, collectCalls(messages), { maxTokens: 100_000, pinnedFrom: messages.length });
    expect(JSON.stringify(fitted.state)).not.toContain('filler text');
    expect(JSON.stringify(fitted.state)).toContain('4000 chars (omitted)');
  });
});

describe('jev', () => {
  test('parseResponse names the failure', () => {
    const kind = (status: number, text: string): string => {
      try {
        parseResponse(status, text, ['q']);
        return 'ok';
      } catch (error) {
        return (error as JevError).kind;
      }
    };
    expect(kind(403, '<!DOCTYPE html>')).toBe('blocked');
    expect(kind(401, '{"detail":"no"}')).toBe('auth');
    expect(kind(400, '{"detail":{"error_type":"max_tokens_exceeded"}}')).toBe('too_large');
    expect(kind(429, '')).toBe('rate');
    expect(kind(502, '')).toBe('server');
    expect(kind(200, 'not json')).toBe('malformed');
    expect(kind(200, '{"answers":{"q":{"noul":-0.1}}}')).toBe('malformed');
    expect(kind(200, '{"answers":{"q":{"type":"noul","noul":0.3}}}')).toBe('ok');
  });

  test('batches stay under the request budget', () => {
    const questions = new Map(Array.from({ length: 300 }, (_, i) => [`q${i}`, { type: 'noul', instructions: big(`q${i}`, 400) }]));
    const batches = batchQuestions(questions, 20_000, 30_000);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.reduce((n, b) => n + Object.keys(b).length, 0)).toBe(300);
  });

  test('askAll retries a rate limit and splits a request that is too large', async () => {
    let calls = 0;
    const transport: Transport = {
      post: async (_url, _headers, body) => {
        calls++;
        const names = Object.keys(JSON.parse(body).questions);
        if (calls === 1) return { status: 429, text: '' };
        if (names.length > 2) return { status: 400, text: 'max_tokens_exceeded' };
        return { status: 200, text: JSON.stringify({ answers: Object.fromEntries(names.map((n) => [n, { noul: 0.5 }])) }) };
      },
      sleep: async () => {},
    };
    const batch = Object.fromEntries(['a', 'b', 'c', 'd'].map((n) => [n, { type: 'noul', instructions: n }]));
    const out = await askAll(transport, { url: 'u', apiKey: 'k', model: 'm' }, {}, [batch]);
    expect([...out.scores.keys()].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(out.requests).toBe(2);
  });
});
