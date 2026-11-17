// Measures how well search finds the right conversation. Each question in eval-questions.json was
// written from one conversation, so that conversation is its known answer. Every question is
// searched once, and its three ranked lists are merged under each SETUP below; a setup scores by
// where the answer lands.
//
//   npm run eval                 (writes eval-results/<date>.json)
//   npm run eval -- windows-v2   (writes eval-results/<date>-windows-v2.json)
//
// Scores, per setup and split into broad and detail questions:
//   top 1 / top 10: share of questions whose answer ranked #1 / in the top 10
//   MRR: mean reciprocal rank, the average of 1 / rank (0 when outside the top 10), so a #1
//        counts 1, a #2 0.5 and a #10 0.1
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pool } from './db.js';
import {
  DEFAULT_WEIGHTS,
  RESULT_LIMIT,
  RRF_K,
  fuse,
  searchLists,
  type Weights,
} from './retrieval.js';

const QUESTIONS_FILE = 'eval-questions.json';
const RESULTS_DIR = 'eval-results';
// Questions searched at once
const CONCURRENCY = 4;

// The weightings compared. Each only changes how the same three lists are merged, so adding one
// costs no extra searches.
const SETUPS: Record<string, Weights> = {
  'summary only': { summary: 1, window: 0, keyword: 0 },
  'summary + keyword': { summary: 1, window: 0, keyword: 0.5 },
  'windows 0.5': { summary: 1, window: 0.5, keyword: 0.5 },
  'windows 1': { summary: 1, window: 1, keyword: 0.5 },
  // What npm run search uses
  current: DEFAULT_WEIGHTS,
};

interface Question {
  chunkId: string;
  startedAt: string;
  substance: string;
  kind: 'broad' | 'detail';
  question: string;
  evidence?: string;
}

interface QuestionResult extends Question {
  // Per setup: the answer's rank (null if it wasn't found at all) and the 3 chunks ranked highest
  setups: Record<string, { rank: number | null; top3: string[] }>;
}

interface Score {
  questions: number;
  top1: number;
  top10: number;
  mrr: number;
}

function score(ranks: (number | null)[]): Score {
  const inTop = (n: number) => ranks.filter((r) => r !== null && r <= n).length / ranks.length;
  const mrr =
    ranks.reduce<number>((sum, r) => sum + (r !== null && r <= RESULT_LIMIT ? 1 / r : 0), 0) /
    ranks.length;
  return { questions: ranks.length, top1: inTop(1), top10: inTop(RESULT_LIMIT), mrr };
}

async function evaluate(question: Question): Promise<QuestionResult> {
  const lists = await searchLists(question.question);
  const setups: QuestionResult['setups'] = {};
  for (const [name, weights] of Object.entries(SETUPS)) {
    const ranked = fuse(lists, weights, Infinity).map(({ id }) => id);
    const index = ranked.indexOf(question.chunkId);
    setups[name] = { rank: index === -1 ? null : index + 1, top3: ranked.slice(0, 3) };
  }
  return { ...question, setups };
}

function gitCommit(): string {
  try {
    const commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim() !== '';
    return dirty ? `${commit} (uncommitted changes)` : commit;
  } catch {
    return 'unknown';
  }
}

const pct = (n: number) => `${Math.round(n * 100)}%`.padStart(5);

try {
  const label = process.argv[2]?.trim();
  const questions = JSON.parse(readFileSync(QUESTIONS_FILE, 'utf8')) as Question[];

  const results: QuestionResult[] = [];
  for (let i = 0; i < questions.length; i += CONCURRENCY) {
    results.push(...(await Promise.all(questions.slice(i, i + CONCURRENCY).map(evaluate))));
    console.log(`[eval] ${results.length}/${questions.length} questions searched`);
  }

  const groups = { all: results, broad: [] as QuestionResult[], detail: [] as QuestionResult[] };
  for (const result of results) groups[result.kind].push(result);
  const scores: Record<string, Record<string, Score>> = {};
  for (const name of Object.keys(SETUPS)) {
    scores[name] = Object.fromEntries(
      Object.entries(groups).map(([group, rs]) => [
        group,
        score(rs.map((r) => r.setups[name]?.rank ?? null)),
      ]),
    );
  }

  const date = new Date().toISOString();
  const file = `${RESULTS_DIR}/${date.slice(0, 10)}${label ? `-${label}` : ''}.json`;
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(
    file,
    JSON.stringify(
      { date, commit: gitCommit(), rrfK: RRF_K, setups: SETUPS, scores, questions: results },
      null,
      2,
    ) + '\n',
  );

  console.log(
    `\n${'setup'.padEnd(20)}  ${'all: top1 top10  MRR'.padEnd(24)}  broad: top10  MRR   detail: top10  MRR`,
  );
  for (const [name, s] of Object.entries(scores)) {
    const { all, broad, detail } = s as Record<'all' | 'broad' | 'detail', Score>;
    console.log(
      `${name.padEnd(20)}  ${pct(all.top1)} ${pct(all.top10)}  ${all.mrr.toFixed(2)}` +
        `        ${pct(broad.top10)}  ${broad.mrr.toFixed(2)}           ${pct(detail.top10)}  ${detail.mrr.toFixed(2)}`,
    );
  }
  console.log(`\n${results.length} questions; full results in ${file}`);
} finally {
  await pool.end();
}
