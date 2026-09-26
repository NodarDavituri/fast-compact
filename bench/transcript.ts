/**
 * Reads Claude Code session transcripts (`~/.claude/projects/<slug>/<id>.jsonl`)
 * into the message shape a `session.compact` hook receives: one message per
 * content block, main thread only.
 *
 * A transcript is cut into segments at every compaction boundary; within a
 * segment the conversation is the parent chain walked back from its last
 * message, so a rewound branch is left out.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Message, ToolResult } from '../src/types.js';

export interface BenchMessage extends Message {
  uuid: string;
  /** Context size in tokens when this assistant message was generated. */
  contextTokens?: number;
  /** Written by the host (reminders, command echoes, compaction summaries). */
  host?: boolean;
}

export interface Segment {
  session: string;
  project: string;
  index: number;
  messages: BenchMessage[];
}

type Block = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

type Rec = {
  type: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  message?: {
    role?: string;
    content?: string | Block[];
    usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
};

const HOST_PREFIXES = [
  '<command-name>',
  '<command-message>',
  '<local-command-',
  '<task-notification>',
  '<system-reminder>',
  'Caveat: The messages below were generated',
];

export function isHostText(text: string): boolean {
  const start = text.trimStart();
  return HOST_PREFIXES.some((prefix) => start.startsWith(prefix));
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: Block) => (part.type === 'text' ? (part.text ?? '') : `[${part.type}]`))
    .join('\n');
}

function toMessage(record: Rec): BenchMessage | undefined {
  const uuid = record.uuid!;
  const content = record.message?.content;
  if (record.type === 'assistant') {
    const block = Array.isArray(content) ? content[0] : undefined;
    const usage = record.message?.usage;
    const contextTokens = usage
      ? (usage.input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0)
      : undefined;
    if (block?.type === 'text' && block.text) {
      return { uuid, role: 'assistant', text: block.text, toolUses: [], contextTokens };
    }
    if (block?.type === 'tool_use' && block.id && block.name) {
      return {
        uuid,
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: block.id, tool: block.name, input: block.input ?? {} }],
        contextTokens,
      };
    }
    return undefined;
  }
  if (typeof content === 'string') {
    const host = record.isMeta || record.isCompactSummary || isHostText(content);
    return { uuid, role: 'user', text: content, toolUses: [], host: host || undefined };
  }
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  const toolResults: ToolResult[] = [];
  for (const block of content) {
    if (block.type === 'text' && block.text) texts.push(block.text);
    else if (block.type === 'image') texts.push('[image]');
    else if (block.type === 'tool_result' && block.tool_use_id) {
      toolResults.push({
        tool_use_id: block.tool_use_id,
        text: resultText(block.content),
        isError: block.is_error === true,
      });
    }
  }
  const text = texts.join('\n');
  if (!text && toolResults.length === 0) return undefined;
  const message: BenchMessage = { uuid, role: 'user', text, toolUses: [] };
  if (toolResults.length > 0) message.toolResults = toolResults;
  if (text && (record.isMeta || record.isCompactSummary || isHostText(text))) message.host = true;
  return message;
}

/** The main-thread segments of one transcript. */
export function readSegments(path: string, project: string): Segment[] {
  const records: Rec[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      records.push(JSON.parse(line) as Rec);
    } catch {
      // a torn last line while the session is still writing
    }
  }
  const segments: Rec[][] = [[]];
  for (const record of records) {
    if (record.type === 'system' && record.subtype === 'compact_boundary') segments.push([]);
    else if (!record.isSidechain) segments[segments.length - 1]!.push(record);
  }
  const session = basename(path, '.jsonl');
  return segments.flatMap((segment, index) => {
    const byUuid = new Map<string, Rec>();
    for (const record of segment) if (record.uuid) byUuid.set(record.uuid, record);
    const leaf = segment.findLast((r) => r.type === 'user' || r.type === 'assistant');
    if (!leaf?.uuid) return [];
    const chain: Rec[] = [];
    const seen = new Set<string>();
    for (let r: Rec | undefined = leaf; r?.uuid && !seen.has(r.uuid); ) {
      seen.add(r.uuid);
      chain.push(r);
      r = r.parentUuid ? byUuid.get(r.parentUuid) : undefined;
    }
    chain.reverse();
    const messages = chain
      .filter((r) => r.type === 'user' || r.type === 'assistant')
      .map(toMessage)
      .filter((m): m is BenchMessage => m !== undefined);
    return messages.length > 0 ? [{ session, project, index, messages }] : [];
  });
}

/** Every transcript under the projects directory, oldest first, skipping ones still being written. */
export function listTranscripts(root: string, quietMs = 10 * 60_000): { path: string; project: string }[] {
  const found: { path: string; project: string; mtime: number }[] = [];
  for (const project of readdirSync(root)) {
    let files: string[];
    try {
      files = readdirSync(join(root, project));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const path = join(root, project, file);
      const mtime = statSync(path).mtimeMs;
      if (Date.now() - mtime < quietMs) continue;
      found.push({ path, project, mtime });
    }
  }
  return found.sort((a, b) => a.mtime - b.mtime).map(({ path, project }) => ({ path, project }));
}
