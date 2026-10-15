import { describe, type Engine, expect, mock, test } from 'claude-code/testing';
import type { On, SessionMessage } from 'claude-code';

// The conversation a compaction runs over: a prompt, five long reads, then ten quick calls.
function conversation(): SessionMessage[] {
  const messages: SessionMessage[] = [{ role: 'user', text: 'Fix the failing test in src/app.ts.', toolUses: [] }];
  const call = (id: string, tool: string, input: Record<string, unknown>, output: string): void => {
    messages.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input, text: output }] });
    messages.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: output, isError: false }] });
  };
  for (let i = 0; i < 5; i++) call(`toolu_read${i}`, 'Read', { file_path: `/repo/src/f${i}.ts` }, `// f${i}\n${'const value = 42; // filler\n'.repeat(300)}END${i}`);
  call('toolu_write', 'Write', { file_path: '/repo/src/new.ts', content: `export const x = 1;\n${'// body\n'.repeat(600)}` }, 'File created');
  for (let i = 0; i < 10; i++) call(`toolu_echo${i}`, 'Bash', { command: `echo ${i}` }, `${i}`);
  return messages;
}

interface World {
  clock: ReturnType<typeof mock.clock>;
  files: Map<string, string>;
  logs: string[];
  requests: { url: string; body: string }[];
  /** Each line the plugin pinned under the prompt, undefined for a clear. */
  status: (string | undefined)[];
}

function world(
  on: On,
  options: {
    env?: Record<string, string>;
    jev?: (body: string) => { status: number; text: string };
    failWrite?: string;
    noSession?: boolean;
    hang?: boolean;
    /** What `$.session.messages()` answers (the meter's transcript); `conversation()` by default. */
    messages?: () => SessionMessage[];
  } = {},
): World {
  mock.env(on, { HOME: '/Users/tester', ...options.env });
  const w: World = { clock: mock.clock(on, { now: 1_790_000_000_000 }), files: new Map(), logs: [], requests: [], status: [] };
  // Core's /compact, which the plugin schedules; its compaction is driven by the test itself.
  on('command.run', (_$, e) => ({ text: e.command === 'compact' ? 'Compacted' : `no /${e.command} here` }));
  on('session.id', () => (options.noSession ? { deny: 'no session here' } : { value: 'sess-1' }));
  on('settings.read', () => ({ value: {} }));
  on('ui.log', (_$, e) => {
    w.logs.push(e.text);
    return { value: undefined };
  });
  on('ui.status', (_$, e) => {
    w.status.push(e.text);
    return { value: undefined };
  });
  on('session.messages', () => ({ value: (options.messages ?? conversation)() }));
  on('session.measure', (_$, e) => ({ changed: e.changed }));
  on('fs.write', (_$, e) => {
    if (options.failWrite && e.path.includes(options.failWrite)) return { deny: 'EACCES' };
    w.files.set(e.path, e.text);
    return { value: undefined };
  });
  on('fs.exists', (_$, e) => ({ value: w.files.has(e.path) }));
  on('fs.read', (_$, e) => {
    const text = w.files.get(e.path);
    return text === undefined ? { deny: 'ENOENT' } : { value: text };
  });
  on('http.fetch', (_$, e) => {
    if (options.hang) return new Promise(() => {});
    const body = String(e.init?.body ?? '');
    w.requests.push({ url: e.url, body });
    const answer = options.jev ? options.jev(body) : { status: 500, text: 'no Jev in this test' };
    return { value: { status: answer.status, ok: answer.status < 300, headers: {}, text: answer.text } };
  });
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'core summary', toolUses: [] }] }));
  return w;
}

/** Jev answering `p` for one named output (by its sample's END marker) and 0.1 for the rest. */
function jevFavouring(marker: string, p: number): (body: string) => { status: number; text: string } {
  return (body) => {
    const questions = JSON.parse(body).questions as Record<string, { instructions: { output_sample?: string } | string }>;
    const answers = Object.fromEntries(
      Object.entries(questions).map(([name, q]) => {
        const sample = typeof q.instructions === 'string' ? '' : (q.instructions.output_sample ?? '');
        return [name, { type: 'noul', noul: sample.includes(marker) ? p : 0.1 }];
      }),
    );
    return { status: 200, text: JSON.stringify({ model: 'typesafe/jev-1.13-test', answers, usage: { input_tokens: 900, cost: 0.00004 } }) };
  };
}

const COMMAND = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } };

/** /fc as the host runs it: the command, the compaction it schedules (by the marker), then the /compact finishing. */
async function fastCompact($: Engine, w: World, args = '') {
  const said = await $.command.run({ command: 'fc', args, ...COMMAND });
  const result = await $.session.compact({ trigger: 'manual', messages: conversation(), instructions: args ? `[fast-compact] ${args}` : '[fast-compact]' });
  await w.clock.advance(1);
  return { said: said.text ?? '', result };
}

const AUTO = { options: { autoCompact: true } };
const cutOf = (messages: readonly SessionMessage[] | undefined): boolean =>
  messages?.some((m) => m.toolResults?.some((r) => r.text.includes('[fast-compact: cut '))) ?? false;
const ledgerOf = (w: World) => JSON.parse(w.files.get([...w.files.keys()].find((p) => /\/ledger-\d{4}-\d{2}\.jsonl$/.test(p))!)!.trim());

describe('native compaction is left alone', () => {
  test('/compact goes to core', async ($, on) => {
    world(on);
    const result = await $.session.compact({ trigger: 'manual', messages: conversation() });
    expect(result.messages?.[0]?.text).toBe('core summary');
  });

  test('auto-compaction goes to core even while /fc is pending', async ($, on) => {
    world(on);
    await $.command.run({ command: 'fc', args: '', ...COMMAND });
    const result = await $.session.compact({ trigger: 'auto', messages: conversation() });
    expect(result.messages?.[0]?.text).toBe('core summary');
  });

  test('a compaction another plugin asks for goes to core', async ($, on) => {
    world(on);
    const result = await $.session.compact({ trigger: 'plugin', messages: conversation() });
    expect(result.messages?.[0]?.text).toBe('core summary');
  });
});

describe('/fc', () => {
  test('cuts old outputs, keeps Jev’s pick whole, archives every cut, reports', async ($, on) => {
    const w = world(on, { env: { OPENROUTER_API_KEY: 'test-key' }, jev: jevFavouring('END2', 0.9) });
    const { said, result } = await fastCompact($, w, 'the test');
    expect(said).toBe('compacting (keeping: the test)…');
    const messages = result.messages!;
    const before = conversation();
    expect(messages).toHaveLength(before.length);
    const outputs = messages.flatMap((m) => m.toolResults ?? []);
    const read = (i: number) => outputs.find((r) => r.tool_use_id === `toolu_read${i}`)!.text;
    expect(read(2)).toBe(before.flatMap((m) => m.toolResults ?? []).find((r) => r.tool_use_id === 'toolu_read2')!.text);
    for (const i of [0, 1, 3, 4]) {
      expect(read(i)).toContain(`[fast-compact: cut `);
      expect(read(i)).toContain(`/Users/tester/.claude/fast-compact/sess-1/output-toolu_read${i}.txt — read it before relying on what was cut]`);
      expect(read(i).endsWith(`END${i}`)).toBe(true);
      expect(w.files.get(`/Users/tester/.claude/fast-compact/sess-1/output-toolu_read${i}.txt`)).toContain(`// f${i}`);
    }
    const write = messages.flatMap((m) => m.toolUses).find((u) => u.tool_use_id === 'toolu_write')!;
    expect(String(write.input['content'])).toContain('from the middle of this content field');
    expect(write.input['file_path']).toBe('/repo/src/new.ts');
    expect(w.requests[0]!.url).toBe('https://openrouter.ai/api/v1/systemone');
    expect(JSON.parse(w.requests[0]!.body).state.focus).toBe('the test');
    expect(w.logs.join('\n')).toMatch(/^.* → .* chars \(−\d+%\); 4 outputs cut, 1 kept whole on Jev’s ranking, 1 input cut; Jev typesafe\/jev-1\.13-test/);
    const ledgerPath = [...w.files.keys()].find((p) => /\/ledger-\d{4}-\d{2}\.jsonl$/.test(p))!;
    const ledger = JSON.parse(w.files.get(ledgerPath)!.trim());
    expect(ledger).toMatchObject({ session: 'sess-1', outputs: 4, inputs: 1, whole: 1, ranking: 'jev', provider: 'openrouter' });
  });

  test('no key: still compacts, keeping the newest whole, and says so', async ($, on) => {
    const w = world(on);
    const { result } = await fastCompact($, w);
    expect(result.messages).toBeDefined();
    expect(w.requests).toHaveLength(0);
    expect(w.logs.join('\n')).toContain('no Jev (no Jev key), newest kept whole');
  });

  test('provider none: never asks Jev, even with a key set', { options: { provider: 'none' } }, async ($, on) => {
    const w = world(on, { env: { OPENROUTER_API_KEY: 'test-key' }, jev: jevFavouring('END2', 0.9) });
    const { result } = await fastCompact($, w);
    expect(cutOf(result.messages)).toBe(true);
    expect(w.requests).toHaveLength(0);
    expect(w.logs.join('\n')).toContain('no Jev (provider none), newest kept whole');
    expect(ledgerOf(w)).toMatchObject({ ranking: 'newest', provider: 'none' });
  });

  test('provider none: no request with the apiKey option set either', { options: { provider: 'none', apiKey: 'k' } }, async ($, on) => {
    const w = world(on, { jev: jevFavouring('END2', 0.9) });
    const { result } = await fastCompact($, w);
    expect(cutOf(result.messages)).toBe(true);
    expect(w.requests).toHaveLength(0);
  });

  test('an unknown provider sends nothing, and the report says why', { options: { provider: 'openroute' } }, async ($, on) => {
    const w = world(on, { env: { OPENROUTER_API_KEY: 'k' }, jev: jevFavouring('END2', 0.9) });
    await fastCompact($, w);
    expect(w.requests).toHaveLength(0);
    expect(w.logs.join('\n')).toContain('no Jev (unknown provider "openroute"), newest kept whole');
  });

  test('Jev blocked by a firewall page: still compacts and names the cause', async ($, on) => {
    const w = world(on, { env: { OPENROUTER_API_KEY: 'k' }, jev: () => ({ status: 403, text: '<!DOCTYPE html><title>blocked</title>' }) });
    const { result } = await fastCompact($, w);
    expect(result.messages).toBeDefined();
    expect(w.logs.join('\n')).toContain('HTML page');
  });

  test('an output whose full text cannot be saved is not cut', async ($, on) => {
    const w = world(on, { failWrite: 'toolu_read0' });
    const { result } = await fastCompact($, w);
    const read0 = result.messages!.flatMap((m) => m.toolResults ?? []).find((r) => r.tool_use_id === 'toolu_read0')!;
    expect(read0.text).not.toContain('[fast-compact: cut ');
  });

  test('nothing old enough: skipped, with the reason in the transcript', async ($, on) => {
    const w = world(on);
    await $.command.run({ command: 'fc', args: '', ...COMMAND });
    const result = await $.session.compact({ trigger: 'manual', messages: conversation().slice(-12), instructions: '[fast-compact]' });
    expect(result.skip).toContain('nothing old enough');
    await w.clock.advance(1);
    expect(w.logs.join('\n')).toContain('nothing old enough');
  });

  test('the scheduled compaction is taken whether the host labels it plugin or manual', async ($, on) => {
    world(on);
    for (const trigger of ['plugin', 'manual'] as const) {
      await $.command.run({ command: 'fc', args: '', ...COMMAND });
      const result = await $.session.compact({ trigger, messages: conversation(), instructions: '[fast-compact]' });
      expect(result.messages?.some((m) => m.toolResults?.some((r) => r.text.includes('[fast-compact: cut ')))).toBe(true);
    }
  });

  test('a /compact that is not the scheduled one goes to core, even while /fc is pending', async ($, on) => {
    world(on);
    await $.command.run({ command: 'fc', args: '', ...COMMAND });
    const plain = await $.session.compact({ trigger: 'manual', messages: conversation() });
    expect(plain.messages?.[0]?.text).toBe('core summary');
  });

  test('a /compact with other instructions while /fc is pending goes to core', async ($, on) => {
    world(on);
    await $.command.run({ command: 'fc', args: '', ...COMMAND });
    const result = await $.session.compact({ trigger: 'manual', messages: conversation(), instructions: 'keep the plan' });
    expect(result.messages?.[0]?.text).toBe('core summary');
  });

  test('a subagent’s compaction is left to core', async ($, on) => {
    world(on);
    await $.command.run({ command: 'fc', args: '', ...COMMAND });
    const result = await $.session.compact({ trigger: 'manual', messages: conversation(), agentId: 'agent-1', instructions: '[fast-compact]' });
    expect(result.messages?.[0]?.text).toBe('core summary');
  });

  test('a marked compaction is taken even with no /fc pending (late, or after a restart)', async ($, on) => {
    world(on);
    const result = await $.session.compact({ trigger: 'manual', messages: conversation(), instructions: '[fast-compact] the plan' });
    expect(result.messages?.some((m) => m.toolResults?.some((r) => r.text.includes('[fast-compact: cut ')))).toBe(true);
  });

  test('a compaction that never reaches the plugin: the log says so, then /fc and the meter are off', async ($, on) => {
    const w = world(on);
    const said = await $.command.run({ command: 'fc', args: '', ...COMMAND });
    expect(said.text).toContain('compacting');
    await w.clock.advance(1);
    expect(w.logs.at(-1)).toContain('did not reach fast-compact, so Claude Code ran its own /compact');
    const again = await $.command.run({ command: 'fc', args: '', ...COMMAND });
    expect(again.text).toContain('off for this session');
    await $.session.measure({ context: { window: 400_000, tokens: 100_000 }, rateLimits: [], changed: ['context'] });
    expect(w.status.at(-1)).toBeUndefined();
  });

  test('a second /fc while the first is running is refused', async ($, on) => {
    world(on);
    await $.command.run({ command: 'fc', args: '', ...COMMAND });
    const again = await $.command.run({ command: 'fc', args: '', ...COMMAND });
    expect(again.text).toBe('a compaction is already running');
  });

  test('a failure on its own compaction is a readable skip, never the summary', async ($, on) => {
    world(on, { noSession: true });
    const result = await $.session.compact({ trigger: 'manual', messages: conversation(), instructions: '[fast-compact]' });
    expect(result.skip).toMatch(/^fast-compact failed \(throw: .*no session here/);
    expect(result.skip).not.toContain('[object Object]');
  });

  test('a Jev endpoint that hangs: ranked newest first, within the budget', async ($, on) => {
    const w = world(on, { env: { OPENROUTER_API_KEY: 'k' }, hang: true });
    const pending = $.session.compact({ trigger: 'manual', messages: conversation(), instructions: '[fast-compact]' });
    for (let i = 0; i < 6; i++) await w.clock.advance(7000);
    const result = await pending;
    expect(result.messages).toBeDefined();
    const ledgerPath = [...w.files.keys()].find((p) => /\/ledger-\d{4}-\d{2}\.jsonl$/.test(p))!;
    const ledger = JSON.parse(w.files.get(ledgerPath)!.trim());
    expect(ledger.ranking).toBe('newest');
    expect(ledger.jev.skipped).toMatch(/no answer|no time left/);
  });
});

describe('autoCompact', () => {
  test('auto-compaction is cut the way /fc cuts, every cut archived, the ledger saying auto', AUTO, async ($, on) => {
    const w = world(on);
    const result = await $.session.compact({ trigger: 'auto', messages: conversation() });
    expect(cutOf(result.messages)).toBe(true);
    expect(w.files.get('/Users/tester/.claude/fast-compact/sess-1/output-toolu_read0.txt')).toContain('// f0');
    expect(ledgerOf(w)).toMatchObject({ trigger: 'auto', session: 'sess-1' });
  });

  test('cuts freeing under a fifth of the conversation: Claude Code summarises', AUTO, async ($, on) => {
    world(on);
    const talk: SessionMessage = { role: 'user', text: 'x'.repeat(400_000), toolUses: [] };
    const result = await $.session.compact({ trigger: 'auto', messages: [talk, ...conversation()] });
    expect(result.messages?.[0]?.text).toBe('core summary');
  });

  test('when even cutting everything would not free enough, Jev is not asked', { options: { autoCompact: true } }, async ($, on) => {
    const w = world(on, { env: { OPENROUTER_API_KEY: 'k' }, jev: jevFavouring('END2', 0.9) });
    const talk: SessionMessage = { role: 'user', text: 'x'.repeat(400_000), toolUses: [] };
    const result = await $.session.compact({ trigger: 'auto', messages: [talk, ...conversation()] });
    expect(result.messages?.[0]?.text).toBe('core summary');
    expect(w.requests).toHaveLength(0);
  });

  test('provider none: auto-compaction is cut without asking Jev', { options: { autoCompact: true, provider: 'none' } }, async ($, on) => {
    const w = world(on, { env: { OPENROUTER_API_KEY: 'k' }, jev: jevFavouring('END2', 0.9) });
    const result = await $.session.compact({ trigger: 'auto', messages: conversation() });
    expect(cutOf(result.messages)).toBe(true);
    expect(w.requests).toHaveLength(0);
  });

  test('nothing old enough to cut: Claude Code summarises', AUTO, async ($, on) => {
    world(on);
    const result = await $.session.compact({ trigger: 'auto', messages: conversation().slice(-12) });
    expect(result.messages?.[0]?.text).toBe('core summary');
  });

  test('a subagent’s auto-compaction is left to core', AUTO, async ($, on) => {
    world(on);
    const result = await $.session.compact({ trigger: 'auto', messages: conversation(), agentId: 'agent-1' });
    expect(result.messages?.[0]?.text).toBe('core summary');
  });

  test('a failure falls back to the summary, never a skip that leaves the context full', AUTO, async ($, on) => {
    world(on, { noSession: true });
    const result = await $.session.compact({ trigger: 'auto', messages: conversation() });
    expect(result.messages?.[0]?.text).toBe('core summary');
  });
});

describe('meter', () => {
  const MEASURE = { context: { window: 400_000, tokens: 100_000 }, rateLimits: [], changed: ['context' as const] };
  const FILE = '/Users/tester/.claude/fast-compact/meter/sess-1';

  test('statusline: after a turn the file holds the tokens /fc would free; a compaction clears it', { options: { meter: 'statusline' } }, async ($, on) => {
    const w = world(on);
    await $.session.measure(MEASURE);
    expect(Number(w.files.get(FILE))).toBeGreaterThan(2_000);
    expect(w.requests).toHaveLength(0);
    await fastCompact($, w);
    expect(w.files.get(FILE)).toBe('');
  });

  test('prompt: a line under the prompt after a turn, cleared by a compaction', { options: { meter: 'prompt' } }, async ($, on) => {
    const w = world(on);
    await $.session.measure(MEASURE);
    expect(w.status.at(-1)).toMatch(/^\/fc frees ~[\d.]+k tokens \(\d+%\) · hide: \/plugin configure fast-compact → meter$/);
    await $.session.compact({ trigger: 'manual', messages: conversation() });
    expect(w.status.at(-1)).toBeUndefined();
  });

  test('both: the line under the prompt and the file', { options: { meter: 'both' } }, async ($, on) => {
    const w = world(on);
    await $.session.measure(MEASURE);
    expect(w.status.at(-1)).toMatch(/^\/fc frees ~[\d.]+k tokens/);
    expect(Number(w.files.get(FILE))).toBeGreaterThan(2_000);
  });

  test('the hint how to hide it: on the first three lines, then dropped', async ($, on) => {
    const w = world(on);
    for (let i = 0; i < 4; i++) await $.session.measure(MEASURE);
    expect(w.status.slice(0, 3).every((line) => line?.endsWith('→ meter'))).toBe(true);
    expect(w.status[3]).toMatch(/^\/fc frees ~[\d.]+k tokens \(\d+%\)$/);
  });

  test('prompt by default: a line, no file', async ($, on) => {
    const w = world(on);
    await $.session.measure(MEASURE);
    expect(w.status.at(-1)).toMatch(/^\/fc frees ~[\d.]+k tokens/);
    expect(w.files.has(FILE)).toBe(false);
  });

  test('both: a compaction clears the line and the file', { options: { meter: 'both' } }, async ($, on) => {
    const w = world(on);
    await $.session.measure(MEASURE);
    await $.session.compact({ trigger: 'manual', messages: conversation() });
    expect(w.status.at(-1)).toBeUndefined();
    expect(w.files.get(FILE)).toBe('');
  });

  test('a measurement where only the rate limits moved leaves the line as it is', async ($, on) => {
    const w = world(on);
    await $.session.measure({ ...MEASURE, changed: ['rateLimits'] });
    expect(w.status).toHaveLength(0);
  });

  test('under 2k tokens to free: no line', async ($, on) => {
    const w = world(on, { messages: () => conversation().slice(-12) });
    await $.session.measure(MEASURE);
    expect(w.status.at(-1)).toBeUndefined();
  });

  test('right after /fc: nothing to show, since what it kept whole stays whole', async ($, on) => {
    let after: SessionMessage[] | undefined;
    const w = world(on, { messages: () => after ?? conversation() });
    const { result } = await fastCompact($, w);
    after = result.messages as SessionMessage[];
    await $.session.measure(MEASURE);
    expect(w.status.at(-1)).toBeUndefined();
  });

  test('off: no file, no line', { options: { meter: 'off' } }, async ($, on) => {
    const w = world(on);
    await $.session.measure(MEASURE);
    expect(w.files.has(FILE)).toBe(false);
    expect(w.status).toHaveLength(0);
  });
});
