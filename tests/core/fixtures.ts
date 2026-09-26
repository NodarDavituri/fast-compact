import type { Message } from '../../src/types.js';

let n = 0;

/** A tool call and its output, as two messages in the hook's shape. */
export function call(tool: string, input: Record<string, unknown>, output: string, isError = false): Message[] {
  const id = `toolu_${String(++n).padStart(4, '0')}`;
  return [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input, text: output }], handle: `h-${id}-a` },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: output, isError }], handle: `h-${id}-u` },
  ];
}

export function user(text: string): Message {
  return { role: 'user', text, toolUses: [], handle: `h-u-${++n}` };
}

export function assistant(text: string): Message {
  return { role: 'assistant', text, toolUses: [], handle: `h-a-${++n}` };
}

export function big(label: string, chars: number): string {
  const line = `${label} line with value ${label}_42 and some filler text to make it long.\n`;
  return line.repeat(Math.ceil(chars / line.length)).slice(0, chars);
}

/** A session: a prompt, `old` long reads, then `recent` short calls. */
export function session(old: number, recent: number, chars = 6000): Message[] {
  const messages: Message[] = [user('Fix the failing test in src/app.ts and keep the API stable.')];
  for (let i = 0; i < old; i++) {
    messages.push(assistant(`Reading file ${i}.`));
    messages.push(...call('Read', { file_path: `/repo/src/file${i}.ts` }, big(`file${i}`, chars)));
  }
  for (let i = 0; i < recent; i++) messages.push(...call('Bash', { command: `echo ${i}` }, `${i}`));
  return messages;
}
