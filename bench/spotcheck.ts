/**
 * A blind check of the *needed* label: a sample of candidates is judged by a
 * reader who sees the output and the work that followed, but neither the
 * label nor any score.
 *
 *   bun bench/spotcheck.ts export   # bench/.cache/spotcheck/batch-<n>.json + key.json
 *   bun bench/spotcheck.ts score    # reads answers-<n>.json beside them
 *
 * Run after `bun bench/run.ts --jev` (it reads the scores from .cache/rows.jsonl).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { goalOf } from './arms.js';
import { auc } from './metrics.js';
import { hash, loadSample } from './points.js';

const DIR = new URL('./.cache/spotcheck/', import.meta.url).pathname;
const ROWS = new URL('./.cache/rows.jsonl', import.meta.url).pathname;
const BATCHES = 4;
const NEEDED = 40;
const NOT_NEEDED = 60;

type Row = { point: string; id: string; needed: boolean; scores: Record<string, number> };

function cut(text: string, head: number, tail: number): string {
  if (text.length <= head + tail + 40) return text;
  return `${text.slice(0, head)}\n[… ${text.length - head - tail} chars omitted …]\n${text.slice(-tail)}`;
}

if (process.argv[2] === 'export') {
  const rows = readFileSync(ROWS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Row);
  const frozen = JSON.parse(readFileSync(new URL('./.cache/sample.json', import.meta.url).pathname, 'utf8')) as string[];
  const { every } = loadSample(`${process.env.HOME}/.claude/projects`, 150, 0);
  const points = every.filter((p) => frozen.includes(p.id));
  const byId = new Map(points.map((p) => [p.id, p]));
  const pick = (needed: boolean, n: number): Row[] =>
    rows
      .filter((r) => r.needed === needed && byId.has(r.point))
      .sort((a, b) => hash(`${a.point}${a.id}`) - hash(`${b.point}${b.id}`))
      .slice(0, n);
  const chosen = [...pick(true, NEEDED), ...pick(false, NOT_NEEDED)].sort(
    (a, b) => hash(`k${a.id}`) - hash(`k${b.id}`),
  );
  mkdirSync(DIR, { recursive: true });
  const key: Record<string, Row> = {};
  const batches: object[][] = Array.from({ length: BATCHES }, () => []);
  chosen.forEach((row, i) => {
    const point = byId.get(row.point)!;
    const candidate = point.candidates.find((c) => c.tool_use_id === row.id)!;
    const call = point.history[candidate.callIndex]!.toolUses.find((t) => t.tool_use_id === row.id)!;
    const output = point.history[candidate.resultIndex]!.toolResults!.find((r) => r.tool_use_id === row.id)!;
    const later: string[] = [];
    for (const m of point.window) {
      if (m.role === 'assistant' && m.text) later.push(`[assistant] ${cut(m.text, 400, 0)}`);
      for (const t of m.toolUses) later.push(`[call ${t.tool}] ${cut(JSON.stringify(t.input), 400, 0)}`);
      if (m.role === 'user' && m.text && !m.host) later.push(`[user] ${cut(m.text, 400, 0)}`);
    }
    const k = `item-${String(i + 1).padStart(3, '0')}`;
    key[k] = row;
    batches[i % BATCHES]!.push({
      key: k,
      goal: goalOf(point.history),
      call: `${call.tool} ${cut(JSON.stringify(call.input), 400, 0)}`,
      output_chars: output.text.length,
      output: cut(output.text, 4000, 2000),
      later_work: cut(later.join('\n'), 5000, 2000),
    });
  });
  batches.forEach((batch, n) => writeFileSync(`${DIR}batch-${n + 1}.json`, JSON.stringify(batch, null, 1)));
  writeFileSync(`${DIR}key.json`, JSON.stringify(key));
  console.log(`${chosen.length} items in ${BATCHES} batches under ${DIR}`);
} else if (process.argv[2] === 'score') {
  const key = JSON.parse(readFileSync(`${DIR}key.json`, 'utf8')) as Record<string, Row>;
  const answers: { key: string; label: string; where?: string }[] = [];
  for (let n = 1; n <= BATCHES; n++) {
    const file = `${DIR}answers-${n}.json`;
    if (existsSync(file)) answers.push(...JSON.parse(readFileSync(file, 'utf8')));
  }
  const judged = answers.filter((a) => a.label === 'needed' || a.label === 'not_needed');
  const table = { both: 0, proxyOnly: 0, readerOnly: 0, neither: 0 };
  for (const a of judged) {
    const proxy = key[a.key]!.needed;
    const reader = a.label === 'needed';
    if (proxy && reader) table.both++;
    else if (proxy) table.proxyOnly++;
    else if (reader) table.readerOnly++;
    else table.neither++;
  }
  const where = new Map<string, number>();
  for (const a of judged) if (a.label === 'needed') where.set(a.where ?? '?', (where.get(a.where ?? '?') ?? 0) + 1);
  console.log(`${answers.length} answers, ${judged.length} decided (${answers.length - judged.length} unclear)`);
  console.log('proxy × reader:', table);
  const readerLabels = judged.map((a) => a.label === 'needed');
  for (const arm of Object.keys(key[judged[0]!.key]!.scores)) {
    const s = judged.map((a) => key[a.key]!.scores[arm]!);
    console.log(`AUC vs reader, ${arm}: ${auc(s, readerLabels)?.toFixed(3) ?? '–'}`);
  }
  console.log('where the needed part sits (reader):', Object.fromEntries(where));
} else {
  console.log('usage: bun bench/spotcheck.ts export|score');
}

if (process.argv[2] === 'score') {
  // At a budget, which of the reader's needed outputs does each ranking keep whole?
  const { wholeSet } = await import('./metrics.js');
  const key = JSON.parse(readFileSync(`${DIR}key.json`, 'utf8')) as Record<string, Row>;
  const answers: { key: string; label: string; where?: string }[] = [];
  for (let n = 1; n <= BATCHES; n++) answers.push(...JSON.parse(readFileSync(`${DIR}answers-${n}.json`, 'utf8')));
  const rows = readFileSync(ROWS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Row);
  const { every } = loadSample(`${process.env.HOME}/.claude/projects`, 150, 0);
  const byId = new Map(every.map((p) => [p.id, p]));
  const scoresOf = (point: string, arm: string): Map<string, number> =>
    new Map(rows.filter((r) => r.point === point).map((r) => [r.id, r.scores[arm]!]));
  const edges = (where?: string): boolean => where === 'start' || where === 'end';
  for (const label of ['needed', 'not_needed']) {
    const items = answers.filter((a) => a.label === label);
    console.log(`\nreader ${label} (${items.length}): kept whole at a budget of`);
    for (const arm of ['random', 'newest', 'largest', 'jev_upstream', 'jev_needed']) {
      const cells = [0.15, 0.3, 0.5].map((f) => {
        let whole = 0;
        let covered = 0;
        for (const a of items) {
          const row = key[a.key]!;
          const set = wholeSet(byId.get(row.point)!.candidates, scoresOf(row.point, arm), f);
          if (set.has(row.id)) whole++;
          if (set.has(row.id) || edges(a.where)) covered++;
        }
        return label === 'needed'
          ? `${f * 100}%: ${whole} whole, ${covered} with edges`
          : `${f * 100}%: ${whole} whole`;
      });
      console.log(`  ${arm.padEnd(14)} ${cells.join('   ')}`);
    }
  }
}
