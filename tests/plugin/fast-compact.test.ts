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
}

function world(on: On, options: { env?: Record<string, string>; jev?: (body: string) => { status: number; text: string }; failWrite?: string } = {}): World {
  mock.env(on, { HOME: '/Users/tester', ...options.env });
  const w: World = { clock: mock.clock(on, { now: 1_790_000_000_000 }), files: new Map(), logs: [], requests: [] };
  // Core's /compact, which the plugin schedules; its compaction is driven by the test itself.
  on('command.run', (_$, e) => ({ text: e.command === 'compact' ? 'Compacted' : `no /${e.command} here` }));
  on('session.id', () => ({ value: 'sess-1' }));
  on('settings.read', () => ({ value: {} }));
  on('ui.log', (_$, e) => {
    w.logs.push(e.text);
    return { value: undefined };
  });
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
    expect(w.logs.join('\n')).toMatch(/^.* → .* chars \(−\d+%\); 4 outputs cut, 1 kept whole on Jev’s ranking, 1 inputs cut; Jev typesafe\/jev-1\.13-test/);
    const ledger = JSON.parse(w.files.get('/Users/tester/.claude/fast-compact/ledger.jsonl')!.trim());
    expect(ledger).toMatchObject({ session: 'sess-1', outputs: 4, inputs: 1, whole: 1, ranking: 'jev', provider: 'openrouter' });
  });

  test('no key: still compacts, keeping the newest whole, and says so', async ($, on) => {
    const w = world(on);
    const { result } = await fastCompact($, w);
    expect(result.messages).toBeDefined();
    expect(w.requests).toHaveLength(0);
    expect(w.logs.join('\n')).toContain('no Jev (no Jev key), newest kept whole');
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
});
