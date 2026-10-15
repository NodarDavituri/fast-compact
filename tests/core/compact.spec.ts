import { describe, expect, test } from 'bun:test';
import { applyCuts, chooseWhole, decide, estimate, fresh, freshBatches, mostFreed, plan, protectedFrom, sizeOf } from '../../src/compact.js';
import type { Transport } from '../../src/jev.js';
import { CUT_MARK, cutChars, cutMiddle } from '../../src/text.js';
import { DEFAULT_OPTIONS, type Cut, type Message } from '../../src/types.js';
import { assistant, big, call, session, user } from './fixtures.js';

const options = DEFAULT_OPTIONS;
const pathOf = (cut: Cut): string => `/archive/${cut.kind}-${cut.key}.txt`;

describe('plan', () => {
  test('the newest calls are protected; only long old outputs are candidates', () => {
    const messages = session(4, 10);
    const p = plan(messages, options);
    expect(p.protectedFrom).toBe(protectedFrom(messages, 10));
    expect(p.outputs.map((c) => c.tool)).toEqual(['Read', 'Read', 'Read', 'Read']);
    expect(p.outputs.every((c) => c.resultIndex < p.protectedFrom)).toBe(true);
  });

  test('fewer calls than keepRecentCalls: nothing is a candidate', () => {
    const p = plan(session(3, 2), options);
    expect(p.outputs).toHaveLength(0);
  });

  test('an output just over cutTo is not worth cutting', () => {
    const messages = [user('go'), ...call('Read', { file_path: 'a' }, big('a', 1600)), ...session(0, 10)];
    expect(plan(messages, options).outputs).toHaveLength(0);
  });

  test('an output cut before is never a candidate again', () => {
    const cutText = `${big('x', 1000)}\n${CUT_MARK}9000 chars from the middle of this output; the full text is in /a]\n${big('y', 500)}`;
    const messages = [user('go'), ...call('Read', { file_path: 'a' }, cutText), ...session(0, 10)];
    expect(plan(messages, options).outputs).toHaveLength(0);
  });

  test('long old inputs and host notices are candidates; person and assistant text never is', () => {
    const messages: Message[] = [
      user('Please write the file.'),
      ...call('Write', { file_path: '/repo/a.ts', content: big('content', 5000) }, 'ok'),
      user(`<system-reminder>${big('reminder', 2000)}</system-reminder>`),
      user(big('a person wrote this long message', 5000)),
      ...session(0, 10),
    ];
    const p = plan(messages, options);
    expect(p.inputs.map((i) => i.field)).toEqual(['content']);
    expect(p.notices).toHaveLength(1);
    expect(p.notices[0]!.text.startsWith('<system-reminder>')).toBe(true);
  });

  test('cutInputs off leaves inputs alone', () => {
    const messages = [user('go'), ...call('Write', { content: big('c', 5000) }, 'ok'), ...session(0, 10)];
    expect(plan(messages, { ...options, cutInputs: false }).inputs).toHaveLength(0);
  });
});

describe('chooseWhole', () => {
  const outputs = plan(session(6, 10, 10_000), options).outputs;

  test('keeps whole in score order, above the floor, within the budget', () => {
    const scores = new Map(outputs.map((c, i) => [c.tool_use_id, [0.9, 0.2, 0.8, 0.5, 0.1, 0.46][i]!]));
    const whole = chooseWhole(outputs, scores, options);
    // budget: 0.25 × 60,000 = 15,000 chars beyond the cut; each whole keep costs 8,500
    expect([...whole]).toEqual([outputs[0]!.tool_use_id]);
    const roomy = chooseWhole(outputs, scores, { ...options, keepWhole: 1 });
    expect(new Set(roomy)).toEqual(new Set([0, 2, 3, 5].map((i) => outputs[i]!.tool_use_id)));
  });

  test('without scores, the newest first', () => {
    const whole = chooseWhole(outputs, undefined, { ...options, keepWhole: 0.3 });
    expect([...whole]).toEqual([outputs[5]!.tool_use_id, outputs[4]!.tool_use_id]);
  });
});

describe('applyCuts', () => {
  test('cuts to start and end with a marker naming the file; untouched messages are the same objects', () => {
    const messages = session(3, 10);
    const p = plan(messages, options);
    const cuts: Cut[] = [
      { kind: 'output', key: p.outputs[0]!.tool_use_id, index: p.outputs[0]!.resultIndex, tool_use_id: p.outputs[0]!.tool_use_id, original: p.outputs[0]!.output },
    ];
    const out = applyCuts(messages, cuts, pathOf, options);
    expect(out).toHaveLength(messages.length);
    const changed = out.filter((m, i) => m !== messages[i]);
    expect(changed).toHaveLength(1);
    const result = changed[0]!.toolResults![0]!;
    expect(changed[0]!.handle).toBeUndefined();
    expect(result.text).toContain(`${CUT_MARK}4500 chars from the middle of this output; the full text is in /archive/output-${p.outputs[0]!.tool_use_id}.txt — read it before relying on what was cut]`);
    expect(result.text.startsWith(p.outputs[0]!.output.slice(0, 1000))).toBe(true);
    expect(result.text.endsWith(p.outputs[0]!.output.slice(-500))).toBe(true);
    expect(sizeOf(out)).toBeLessThan(sizeOf(messages));
  });

  test('an input field is cut in place; the call and its other fields stay', () => {
    const content = big('content', 5000);
    const messages = [user('go'), ...call('Write', { file_path: '/repo/a.ts', content }, 'ok'), ...session(0, 10)];
    const p = plan(messages, options);
    const cuts: Cut[] = p.inputs.map((i) => ({ kind: 'input', key: `${i.call.tool_use_id}-content`, index: i.call.callIndex, tool_use_id: i.call.tool_use_id, field: 'content', original: i.text }));
    const out = applyCuts(messages, cuts, pathOf, options);
    const use = out[1]!.toolUses[0]!;
    expect(use.input['file_path']).toBe('/repo/a.ts');
    expect(String(use.input['content'])).toContain('from the middle of this content field');
    expect(use.tool).toBe('Write');
  });

  test('a notice keeps its start and a marker', () => {
    const notice = `<system-reminder>${big('r', 3000)}</system-reminder>`;
    const messages = [user('go'), user(notice), ...session(0, 10)];
    const out = applyCuts(messages, [{ kind: 'notice', key: 'm1', index: 1, original: notice }], pathOf, options);
    expect(out[1]!.text.startsWith(notice.slice(0, 300))).toBe(true);
    expect(out[1]!.text).toContain('chars of this notice; the full text is in /archive/notice-m1.txt');
  });
});

function fakeTransport(answer: (questions: Record<string, unknown>) => { status: number; text: string }): Transport & { bodies: string[] } {
  const bodies: string[] = [];
  return {
    bodies,
    post: async (_url, _headers, body) => {
      bodies.push(body);
      return answer(JSON.parse(body).questions);
    },
    sleep: async () => {},
  };
}

describe('fresh', () => {
  test('a parallel batch comes back as one call message and one result message, without handles', () => {
    const [a1, r1] = call('Bash', { command: 'cat a' }, 'A');
    const [a2, r2] = call('Bash', { command: 'cat b' }, 'B');
    const [a3, r3] = call('Bash', { command: 'cat c' }, 'C');
    const out = fresh([user('go'), assistant('reading both'), a1!, a2!, r1!, r2!, a3!, r3!, assistant('done')]);
    expect(out.map((m) => [m.role, m.toolUses.length, m.toolResults?.length ?? 0])).toEqual([
      ['user', 0, 0],
      ['assistant', 2, 0],
      ['user', 0, 2],
      ['assistant', 1, 0],
      ['user', 0, 1],
      ['assistant', 0, 0],
    ]);
    expect(out[1]!.text).toBe('reading both');
    expect(out[2]!.toolResults!.map((r) => r.text)).toEqual(['A', 'B']);
    expect(out.every((m) => m.handle === undefined)).toBe(true);
  });

  test('one call at a time keeps every message; a user text is never merged', () => {
    const messages = [user('go'), ...session(0, 3), user('next')];
    expect(fresh(messages)).toHaveLength(messages.length);
    expect(fresh([user('a'), user('b')])).toHaveLength(2);
  });
});

describe('decide', () => {
  const messages = session(5, 10, 8000);
  const config = { url: 'https://example.test', apiKey: 'k', model: 'jev-latest' };
  const now = async (): Promise<number> => 0;

  test("Jev's scores choose what stays whole", async () => {
    const transport = fakeTransport((qs) => ({
      status: 200,
      text: JSON.stringify({
        model: 'typesafe/jev-1.13',
        answers: Object.fromEntries(Object.keys(qs).map((name, i) => [name, { type: 'noul', noul: i === 2 ? 0.9 : 0.1 }])),
        usage: { input_tokens: 1234, cost: 0.0001 },
      }),
    }));
    const d = await decide(messages, options, { transport, config, now }, 'the API');
    expect(d.ranking).toBe('jev');
    expect(d.whole.size).toBe(1);
    expect(d.whole.has(d.plan.outputs[2]!.tool_use_id)).toBe(true);
    expect(d.cuts.filter((c) => c.kind === 'output')).toHaveLength(4);
    const body = JSON.parse(transport.bodies[0]!);
    expect(body.state.focus).toBe('the API');
    expect(body.state.goal).toContain('Fix the failing test');
    expect(body.state.context).not.toContain('re-run');
    expect(d.jev!.cost).toBeCloseTo(0.0001);
  });

  test('Jev failing ranks newest first and says why; the compaction still goes ahead', async () => {
    const transport = fakeTransport(() => ({ status: 403, text: '<!DOCTYPE html><html>blocked</html>' }));
    const d = await decide(messages, options, { transport, config, now });
    expect(d.ranking).toBe('newest');
    expect(d.jevSkipped).toContain('HTML page');
    expect(d.cuts.length).toBeGreaterThan(0);
  });

  test('no key: newest first', async () => {
    const d = await decide(messages, options, undefined);
    expect(d.ranking).toBe('newest');
    expect(d.jevSkipped).toBe('no Jev key');
  });

  test('an out-of-range probability is not trusted', async () => {
    const transport = fakeTransport((qs) => ({
      status: 200,
      text: JSON.stringify({ answers: Object.fromEntries(Object.keys(qs).map((name) => [name, { noul: 1.7 }])) }),
    }));
    const d = await decide(messages, options, { transport, config, now });
    expect(d.ranking).toBe('newest');
    expect(d.jevSkipped).toContain('no valid answer');
  });
});

describe('estimate', () => {
  test('what /fc would free without Jev: the newest kept whole, the rest cut to cutTo', async () => {
    const freed = await estimate(session(4, 10), options);
    // four 6000-char reads, a quarter kept whole: three cut to about 1500 chars each
    expect(freed.outputs).toBe(3);
    expect(freed.chars).toBeGreaterThan(3 * 4000);
    expect(freed.chars).toBeLessThan(3 * 4500);
    expect(freed.tokens).toBeGreaterThan(freed.chars / 6);
    expect(freed.tokens).toBeLessThan(freed.chars / 2);
  });

  test('nothing old enough: nothing to free', async () => {
    expect(await estimate(session(3, 2), options)).toEqual({ chars: 0, tokens: 0, outputs: 0 });
  });
});

describe('a second compaction', () => {
  test('keeps whole what the first kept whole: earlier cuts count in the budget at their full size', async () => {
    const options = { ...DEFAULT_OPTIONS, keepRecentCalls: 2 };
    const messages = session(40, 2, 10_000);
    const first = await decide(messages, options, undefined);
    expect(first.whole.size).toBeGreaterThan(5);
    const once = applyCuts(messages, first.cuts, pathOf, options);
    const second = await decide(once, options, undefined);
    expect(second.whole).toEqual(first.whole);
    expect(second.cuts.filter((c) => c.kind === 'output')).toHaveLength(0);
    expect((await estimate(once, options)).tokens).toBe(0);
  });

  test('cutChars reads what a whole marker took, and nothing from a quote of its opening', () => {
    expect(cutChars(cutMiddle('a'.repeat(5000), 1500, '/x/output-t1.txt', 'this output'))).toBe(3500);
    expect(cutChars('grep "[fast-compact: cut 12 chars" in the source')).toBe(0);
  });
});

describe('mostFreed', () => {
  test('at least what the meter estimates, and 0 with nothing old enough', async () => {
    const messages = session(6, 10);
    expect(mostFreed(messages, options)).toBeGreaterThanOrEqual((await estimate(messages, options)).chars);
    expect(mostFreed(session(0, 10), options)).toBe(0);
  });
});

describe('freshBatches (resumeSafe off)', () => {
  const parallel = (): Message[] => [
    user('go'),
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Agent', input: { prompt: 'x' } }], handle: 'h1' },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'b', tool: 'Agent', input: { prompt: 'y' } }], handle: 'h2' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: 'A', isError: false }], handle: 'h3' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'b', text: 'B', isError: false }], handle: 'h4' },
  ];

  test('a parallel batch with a rebuilt message is merged, without handles', () => {
    const messages = parallel();
    const { handle: _h, ...rebuilt } = messages[1]!;
    messages[1] = rebuilt;
    const out = freshBatches(messages);
    expect(out).toHaveLength(3);
    expect(out[1]!.toolUses.map((u) => u.tool_use_id)).toEqual(['a', 'b']);
    expect(out[2]!.toolResults!.map((r) => r.tool_use_id)).toEqual(['a', 'b']);
    expect(out[0]!.handle).toBe(messages[0]!.handle);
    expect(out.slice(1).every((m) => m.handle === undefined)).toBe(true);
  });

  test('an untouched batch, and calls in sequence, keep their handles', () => {
    const untouched = parallel();
    expect(freshBatches(untouched)).toEqual(untouched);
    const sequence = session(3, 3);
    const { handle: _h, ...rebuilt } = sequence[3]!;
    sequence[3] = rebuilt;
    expect(freshBatches(sequence)).toEqual(sequence);
  });
});
