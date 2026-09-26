/**
 * Replays compaction points from local Claude Code transcripts and compares
 * the methods in `arms.ts` on the labels from `points.ts`.
 *
 *   bun bench/run.ts                 # baselines only, no network
 *   bun bench/run.ts --jev           # plus the Jev arms (OPENROUTER_API_KEY)
 *   bun bench/run.ts --jev --write   # also writes bench/RESULTS.md
 *   --n 60   points to sample   --root <dir>   transcripts (~/.claude/projects)
 *
 * Nothing from a transcript leaves the machine except the Jev requests
 * themselves; `bench/.cache/` (gitignored) keeps the answers and per-candidate
 * rows (ids, sizes, labels, scores — no content).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { baselineScores, neededJev, pluginJev, upstreamJev, type Scores } from './arms.js';
import { protectedFrom } from '../src/compact.js';
import { DEFAULT_OPTIONS } from '../src/types.js';
import { redactedTotal } from './jev.js';
import {
  addTally,
  auc,
  budgeted,
  emptyTally,
  headTail,
  pluginPolicy,
  fixedCut,
  recall,
  tilted,
  type Tally,
  upstreamDecisions,
} from './metrics.js';
import { loadSample, type Point } from './points.js';

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const option = (name: string, fallback: string): string => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : (args[at + 1] ?? fallback);
};

const N = Number(option('n', '150'));
const ROOT = option('root', `${process.env.HOME}/.claude/projects`);
const FRACTIONS = [0.15, 0.3, 0.5];

interface Row {
  point: string;
  id: string;
  project: string;
  tool: string;
  chars: number;
  isError: boolean;
  needed: boolean;
  tokens: number;
  scores: Record<string, number>;
  action?: string;
}

// The sample is frozen in .cache/sample.json on the first run, so later runs and the
// spot check see the same points while transcripts keep changing; --resample redraws it.
const SAMPLE = new URL('./.cache/sample.json', import.meta.url).pathname;
const frozen: string[] | undefined =
  existsSync(SAMPLE) && !flag('resample') ? JSON.parse(readFileSync(SAMPLE, 'utf8')) : undefined;
const loaded = loadSample(ROOT, N, frozen ? 0 : undefined);
const available = loaded.all;
const points = frozen
  ? loaded.every.filter((p) => frozen.includes(p.id))
  : loaded.points;
if (!frozen) {
  mkdirSync(new URL('./.cache/', import.meta.url).pathname, { recursive: true });
  writeFileSync(SAMPLE, JSON.stringify(points.map((p) => p.id)));
}
if (frozen && points.length < frozen.length) {
  console.log(`warning: ${frozen.length - points.length} frozen points no longer found`);
}
const candidates = points.reduce((n, p) => n + p.candidates.length, 0);
const needed = points.reduce((n, p) => n + p.candidates.filter((c) => c.needed).length, 0);
console.log(
  `${available} points available; sampled ${points.length} from ${new Set(points.map((p) => p.session)).size} sessions in ${new Set(points.map((p) => p.project)).size} projects: ${candidates} candidates, ${needed} needed (${((100 * needed) / candidates).toFixed(1)}%)`,
);

const arms = new Map<string, Map<string, Scores>>();
const setScores = (arm: string, point: Point, scores: Scores): void => {
  const byPoint = arms.get(arm) ?? new Map<string, Scores>();
  byPoint.set(point.id, scores);
  arms.set(arm, byPoint);
};
const upstreamActions = new Map<string, Map<string, import('./upstream/types.js').CallAction>>();
const jevTotals = { cost: 0, inputTokens: 0, requests: 0, cached: 0, stages: new Map<string, number>(), model: '' };
const failures: string[] = [];

for (const point of points) {
  for (const [arm, scores] of Object.entries(baselineScores(point))) setScores(arm, point, scores);
  setScores(
    'oracle',
    point,
    new Map(point.candidates.map((c) => [c.tool_use_id, c.neededTokens.length / c.resultChars])),
  );
}

if (flag('jev')) {
  let done = 0;
  await Promise.all(
    points.map(async (point) => {
      try {
        const [j0, j1, j1ns, jp] = await Promise.all([
          upstreamJev(point),
          neededJev(point, true),
          neededJev(point, false),
          pluginJev(point),
        ]);
        setScores('jev_plugin', point, jp.scores);
        setScores('jev_upstream', point, j0.scores);
        setScores('jev_needed', point, j1.scores);
        setScores('jev_needed_nosample', point, j1ns.scores);
        setScores(
          'jev_needed+errors',
          point,
          new Map(point.candidates.map((c) => [c.tool_use_id, (c.isError ? 10 : 0) + j1.scores.get(c.tool_use_id)!])),
        );
        upstreamActions.set(point.id, j0.actions);
        for (const run of [j0, j1, j1ns, jp]) {
          jevTotals.cost += run.cost;
          jevTotals.inputTokens += run.inputTokens;
          jevTotals.requests += run.requests;
          jevTotals.cached += run.cached;
          jevTotals.model = run.model || jevTotals.model;
        }
        jevTotals.stages.set(j1.stage, (jevTotals.stages.get(j1.stage) ?? 0) + 1);
      } catch (error) {
        failures.push(`${point.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
      done++;
      if (done % 10 === 0) console.log(`  jev: ${done}/${points.length} points`);
    }),
  );
}

// Only points every arm scored are compared.
const scored = points.filter((p) => [...arms.values()].every((byPoint) => byPoint.has(p.id)));

const rows: Row[] = [];
for (const point of scored) {
  for (const c of point.candidates) {
    const scores: Record<string, number> = {};
    for (const [arm, byPoint] of arms) scores[arm] = byPoint.get(point.id)!.get(c.tool_use_id)!;
    rows.push({
      point: point.id,
      id: c.tool_use_id,
      project: point.project.replace(/^-Users-[^-]+-localdev-/, ''),
      tool: c.tool,
      chars: c.resultChars,
      isError: c.isError,
      needed: c.needed,
      tokens: c.neededTokens.length,
      scores,
      action: upstreamActions.get(point.id)?.get(c.tool_use_id),
    });
  }
}
mkdirSync(new URL('./.cache/', import.meta.url).pathname, { recursive: true });
// Only a run with the Jev arms writes the rows the spot check reads.
writeFileSync(
  new URL(flag('jev') ? './.cache/rows.jsonl' : './.cache/rows-offline.jsonl', import.meta.url).pathname,
  rows.map((r) => JSON.stringify(r)).join('\n'),
);

function tallyOver(ps: readonly Point[], f: (p: Point) => Tally): Tally {
  return ps.reduce((t, p) => addTally(t, f(p)), emptyTally());
}

function bootstrap(ps: readonly Point[], f: (p: Point) => Tally, runs = 1000): [number, number] {
  const perPoint = ps.map(f);
  const values: number[] = [];
  let seed = 12345;
  const rand = (): number => ((seed = Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
  for (let r = 0; r < runs; r++) {
    const t = emptyTally();
    for (let i = 0; i < perPoint.length; i++) addTally(t, perPoint[Math.floor(rand() * perPoint.length)]!);
    values.push(recall(t).tokens);
  }
  values.sort((a, b) => a - b);
  return [values[Math.floor(runs * 0.025)]!, values[Math.floor(runs * 0.975)]!];
}

const pct = (x: number): string => (Number.isNaN(x) ? '–' : `${(100 * x).toFixed(0)}%`);
const lines: string[] = [];
const header = ['method', 'AUC pooled', 'AUC per point', ...FRACTIONS.map((f) => `tokens kept @${f * 100}%`), ...FRACTIONS.map((f) => `needed results @${f * 100}%`), 'tokens @30% 95% CI'];
lines.push(`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`);
for (const [arm, byPoint] of arms) {
  const s: number[] = [];
  const y: boolean[] = [];
  const perPoint: number[] = [];
  for (const point of scored) {
    const scores = byPoint.get(point.id)!;
    const ps = point.candidates.map((c) => scores.get(c.tool_use_id)!);
    const ys = point.candidates.map((c) => c.needed);
    s.push(...ps);
    y.push(...ys);
    const a = auc(ps, ys);
    if (a !== undefined) perPoint.push(a);
  }
  const at = FRACTIONS.map((f) => recall(tallyOver(scored, (p) => budgeted(p.candidates, byPoint.get(p.id)!, f))));
  const ci = bootstrap(scored, (p) => budgeted(p.candidates, byPoint.get(p.id)!, 0.3));
  lines.push(
    `| ${arm} | ${auc(s, y)?.toFixed(3) ?? '–'} | ${(perPoint.reduce((a, b) => a + b, 0) / perPoint.length).toFixed(3)} | ${at.map((r) => pct(r.tokens)).join(' | ')} | ${at.map((r) => pct(r.results)).join(' | ')} | ${pct(ci[0])}–${pct(ci[1])} |`,
  );
}
const ht = FRACTIONS.map((f) => recall(tallyOver(scored, (p) => headTail(p.candidates, f))));
const htCi = bootstrap(scored, (p) => headTail(p.candidates, 0.3));
lines.push(
  `| head_tail (every result cut to the budget) | – | – | ${ht.map((r) => pct(r.tokens)).join(' | ')} | ${ht.map((r) => pct(r.results)).join(' | ')} | ${pct(htCi[0])}–${pct(htCi[1])} |`,
);

for (const arm of ['random', 'jev_needed', 'largest']) {
  const byPoint = arms.get(arm);
  if (!byPoint) continue;
  const at = FRACTIONS.map((f) => recall(tallyOver(scored, (p) => tilted(p.candidates, byPoint.get(p.id)!, f))));
  const ci = bootstrap(scored, (p) => tilted(p.candidates, byPoint.get(p.id)!, 0.3));
  lines.push(
    `| head_tail tilted by ${arm} | – | – | ${at.map((r) => pct(r.tokens)).join(' | ')} | ${at.map((r) => pct(r.results)).join(' | ')} | ${pct(ci[0])}–${pct(ci[1])} |`,
  );
}

const policyLines = ['', '| the plugin rule (newest 10 calls and outputs under 1,950 chars whole; the rest cut to 1,000 + 500 unless kept whole) | size kept | tokens kept | needed results | head_tail at the same size: tokens | needed results |', '|---|---|---|---|---|---|'];
const policyOf = (label: string, scoresOf: (p: Point) => Scores | undefined, keepWhole = DEFAULT_OPTIONS.keepWhole): void => {
  const r = recall(tallyOver(scored, (p) => pluginPolicy(p.candidates, scoresOf(p), protectedFrom(p.history as never, DEFAULT_OPTIONS.keepRecentCalls), { ...DEFAULT_OPTIONS, keepWhole })));
  const same = recall(tallyOver(scored, (p) => headTail(p.candidates, r.size)));
  policyLines.push(`| ${label} | ${pct(r.size)} | ${pct(r.tokens)} | ${pct(r.results)} | ${pct(same.tokens)} | ${pct(same.results)} |`);
};
policyOf('no whole keeps (every old output cut)', () => undefined, 0);
policyOf('newest kept whole (no Jev)', () => undefined);
if (arms.has('jev_plugin')) policyOf('Jev keeps whole (as shipped)', (p) => arms.get('jev_plugin')!.get(p.id));
lines.push(...policyLines);

const fixedLines = ['', '| fixed cut per result | size kept | tokens kept | needed results | head_tail at the same size: tokens |', '|---|---|---|---|---|'];
for (const chars of [300, 1000, 2000, 4000]) {
  const f = recall(tallyOver(scored, (p) => fixedCut(p.candidates, chars)));
  const same = recall(tallyOver(scored, (p) => headTail(p.candidates, f.size)));
  fixedLines.push(`| ${chars} chars | ${pct(f.size)} | ${pct(f.tokens)} | ${pct(f.results)} | ${pct(same.tokens)} |`);
}
lines.push(...fixedLines);

if (upstreamActions.size > 0) {
  const u = recall(tallyOver(scored, (p) => upstreamDecisions(p.candidates, upstreamActions.get(p.id)!)));
  const same = recall(tallyOver(scored, (p) => headTail(p.candidates, u.size)));
  const counts = new Map<string, number>();
  for (const r of rows) if (r.action) counts.set(r.action, (counts.get(r.action) ?? 0) + 1);
  lines.push(
    '',
    `Upstream as shipped (0.5 threshold): kept ${pct(u.size)} of candidate characters; tokens kept ${pct(u.tokens)}, needed results ${pct(u.results)}; decisions ${[...counts].map(([k, v]) => `${k} ${v}`).join(', ')}. head_tail at the same size: tokens ${pct(same.tokens)}, needed results ${pct(same.results)}.`,
  );
}

const historyChars = scored.reduce((n, p) => n + p.history.reduce((m, msg) => m + msg.text.length + msg.toolUses.reduce((k, t) => k + JSON.stringify(t.input).length, 0) + (msg.toolResults ?? []).reduce((k, r) => k + r.text.length, 0), 0), 0);
const candidateChars = rows.reduce((n, r) => n + r.chars, 0);
const summary = [
  `Cuttable results are ${pct(candidateChars / historyChars)} of the history's characters (text, tool inputs and outputs) at the points.`,
  `${scored.length} points from ${new Set(scored.map((p) => p.session)).size} sessions in ${new Set(scored.map((p) => p.project)).size} projects; ${rows.length} candidate results (≥500 chars, outside the pinned first and last 6 messages), ${rows.filter((r) => r.needed).length} needed (${pct(rows.filter((r) => r.needed).length / rows.length)}), ${rows.reduce((n, r) => n + r.tokens, 0)} needed tokens.`,
];
if (flag('jev')) {
  summary.push(
    `Jev: ${jevTotals.model}, ${jevTotals.requests} requests (${jevTotals.cached} from cache), ${(jevTotals.inputTokens / 1e6).toFixed(2)}M input tokens, $${jevTotals.cost.toFixed(3)}; ${redactedTotal} credential-shaped strings masked; state stages ${[...jevTotals.stages].map(([k, v]) => `${k} ${v}`).join(', ')}.`,
  );
  if (failures.length) summary.push(`Failed points (left out): ${failures.join('; ')}`);
}
const report = [...summary, '', ...lines].join('\n');
console.log(`\n${report}`);
if (flag('write')) {
  writeFileSync(new URL('./RESULTS.md', import.meta.url).pathname, `# Bench results\n\n${new Date().toISOString().slice(0, 10)}. Method: [README](README.md).\n\n${report}\n`);
}
