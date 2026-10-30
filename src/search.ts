// Asks a question and prints the 10 conversations that best answer it, found two ways and
// merged: by meaning (the question's embedding against each summary's) and by keyword (the
// question's words against the raw messages, which keep names, slang and exact wording that
// summaries leave out).
//
//   npm run search "when did we plan the elden ring night?"
//   npm run search "did @ac ever hit 225 bench"     (@name: only conversations that person was in)
//   npm run search                                  (prompts for questions until a blank line)
import { createInterface } from 'node:readline/promises';
import { pool } from './db.js';
import { EMBEDDING_MODEL, embed } from './embedding.js';

const RESULT_LIMIT = 10;
// How many of each search's best chunks are merged; a chunk ranked lower than this in one search
// can still make the results on the strength of the other
const CANDIDATE_LIMIT = 50;
// Reciprocal rank fusion's damping constant: the smaller it is, the more a top rank in one search
// counts against middling ranks in both. The usual default is 60, which made a chunk ranked #9 and
// #34 beat one ranked #1 by keyword alone; with only 50 candidates each, the top of a list is
// what matters, so it's lower here.
const RRF_K = 10;

// Matches the "@name" a question uses to mean a person
const MENTION = /@([\w.]+)/g;

interface Author {
  id: string;
  name: string;
}

// Each person's most recent name, for resolving @name. Loaded once per run.
let authors: Promise<Author[]> | undefined;
function loadAuthors(): Promise<Author[]> {
  authors ??= pool
    .query<Author>(
      `SELECT DISTINCT ON (author_id) author_id AS id, author_name AS name
       FROM messages
       WHERE NOT author_is_bot
       ORDER BY author_id, id DESC`,
    )
    .then(({ rows }) => rows);
  return authors;
}

// The people "@name" most likely means: an exact name if there is one, otherwise names starting
// with it ("@ac" is ac4228), otherwise names containing it ("@snover" is its.snover). Case is
// ignored. Empty when nobody matches.
async function resolveMention(mention: string): Promise<Author[]> {
  const wanted = mention.toLowerCase();
  const all = await loadAuthors();
  const tiers = [
    all.filter(({ name }) => name.toLowerCase() === wanted),
    all.filter(({ name }) => name.toLowerCase().startsWith(wanted)),
    all.filter(({ name }) => name.toLowerCase().includes(wanted)),
  ];
  return tiers.find((tier) => tier.length > 0) ?? [];
}

interface ParsedQuestion {
  // The question with each resolved @name replaced by the person's name, which is how summaries
  // refer to them
  semanticText: string;
  // The question with resolved @names left out, since they filter by author instead of being
  // words to find. Unresolved ones stay in as plain words ("@tyler" is someone talked about).
  keywordText: string;
  // Only conversations these people wrote in are searched; null searches everyone's
  authors: Author[] | null;
}

async function parseQuestion(question: string): Promise<ParsedQuestion> {
  const resolved = new Map<string, Author[]>();
  for (const [, mention] of question.matchAll(MENTION)) {
    if (mention && !resolved.has(mention)) resolved.set(mention, await resolveMention(mention));
  }

  const replaceMentions = (withName: (people: Author[]) => string) =>
    question.replace(MENTION, (_, mention: string) => {
      const people = resolved.get(mention) ?? [];
      return people.length > 0 ? withName(people) : mention;
    });
  const people = [...resolved.values()].flat();

  return {
    semanticText: replaceMentions((matches) => matches.map(({ name }) => name).join(' or ')),
    // websearch_to_tsquery reads "-word" as "without word", which an any-word search can't
    // honour, so a leading dash is dropped and the word searched like the rest
    keywordText: replaceMentions(() => '').replace(/(^|\s)-(?=\S)/g, '$1'),
    authors: people.length > 0 ? people : null,
  };
}

// The chunks whose summary embeddings are closest to the question's, best first. Only chunks
// embedded with the current model are compared, since vectors from different models don't share
// a space.
async function semanticSearch(text: string, authorIds: string[] | null): Promise<string[]> {
  const [vector] = await embed([text], 'query');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // With an author filter, the HNSW index would otherwise find its usual ~40 nearest chunks
    // and then drop the ones that fail the filter, leaving too few. An iterative scan keeps
    // walking the index until enough pass.
    await client.query(`SET LOCAL hnsw.iterative_scan = strict_order`);
    const { rows } = await client.query<{ id: string }>(
      `SELECT c.id
       FROM chunks c
       WHERE c.embedding_model = $2
         AND ($3::bigint[] IS NULL OR EXISTS (
           SELECT 1 FROM messages m
           WHERE m.channel_id = c.channel_id
             AND m.id BETWEEN c.first_message_id AND c.last_message_id
             AND m.author_id = ANY($3)
         ))
       ORDER BY c.embedding <=> $1::vector
       LIMIT $4`,
      [JSON.stringify(vector), EMBEDDING_MODEL, authorIds, CANDIDATE_LIMIT],
    );
    await client.query('COMMIT');
    return rows.map(({ id }) => id);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

interface KeywordHit {
  id: string;
  // The best-matching message in the chunk, to show why it was found
  bestMatch: string;
}

// The chunks whose messages best match the question's words, best first.
//
// websearch_to_tsquery turns the question into stemmed search terms with stopwords removed, joined
// by & (every term required). That's too strict for a whole question, so the &s become |s and any
// term matches; ts_rank then scores messages that match more of the terms, or match them more
// often, higher. A chunk ranks by its best message, with ties going to the chunk with more
// matching messages. When authors are given, only their messages are searched.
async function keywordSearch(text: string, authorIds: string[] | null): Promise<KeywordHit[]> {
  const { rows } = await pool.query<KeywordHit>(
    `WITH query AS (
       SELECT replace(websearch_to_tsquery('english', $1)::text, ' & ', ' | ')::tsquery AS q
     ), hits AS (
       SELECT m.channel_id, m.id, m.author_name, m.content, ts_rank(m.search_tsv, query.q) AS rank
       FROM messages m, query
       WHERE m.search_tsv @@ query.q
         AND m.deleted_at IS NULL AND NOT m.author_is_bot
         AND ($2::bigint[] IS NULL OR m.author_id = ANY($2))
     )
     SELECT c.id,
            (array_agg(h.author_name || ': ' || h.content ORDER BY h.rank DESC))[1] AS "bestMatch"
     FROM hits h
     JOIN chunks c ON c.channel_id = h.channel_id
                  AND h.id BETWEEN c.first_message_id AND c.last_message_id
     WHERE c.summary IS NOT NULL
     GROUP BY c.id
     ORDER BY max(h.rank) DESC, count(*) DESC
     LIMIT $3`,
    [text, authorIds, CANDIDATE_LIMIT],
  );
  return rows;
}

interface FusedResult {
  id: string;
  score: number;
  semanticRank?: number;
  keywordRank?: number;
  bestMatch?: string;
}

// Reciprocal rank fusion: each search gives a chunk 1 / (RRF_K + rank) points, and the points are
// added up. Only ranks are used, not the searches' own scores, which aren't on comparable scales
// (cosine similarity vs ts_rank). A chunk both searches found beats one only a single search
// ranked a little higher.
function fuse(semantic: string[], keyword: KeywordHit[]): FusedResult[] {
  const results = new Map<string, FusedResult>();
  const entry = (id: string) => {
    let result = results.get(id);
    if (!result) results.set(id, (result = { id, score: 0 }));
    return result;
  };

  semantic.forEach((id, i) => {
    const result = entry(id);
    result.semanticRank = i + 1;
    result.score += 1 / (RRF_K + i + 1);
  });
  keyword.forEach(({ id, bestMatch }, i) => {
    const result = entry(id);
    result.keywordRank = i + 1;
    result.bestMatch = bestMatch;
    result.score += 1 / (RRF_K + i + 1);
  });

  return [...results.values()].sort((a, b) => b.score - a.score).slice(0, RESULT_LIMIT);
}

interface ChunkDetails {
  id: string;
  channelName: string;
  startedAt: Date;
  summary: string;
}

async function chunkDetails(ids: string[]): Promise<Map<string, ChunkDetails>> {
  const { rows } = await pool.query<ChunkDetails>(
    `SELECT c.id, ch.name AS "channelName", c.started_at AS "startedAt", c.summary
     FROM chunks c
     JOIN channels ch ON ch.id = c.channel_id
     WHERE c.id = ANY($1::bigint[])`,
    [ids],
  );
  return new Map(rows.map((row) => [row.id, row]));
}

const oneLine = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

async function printResults(question: string): Promise<void> {
  const { semanticText, keywordText, authors } = await parseQuestion(question);
  const authorIds = authors?.map(({ id }) => id) ?? null;
  if (authors) {
    console.log(`Only conversations with ${authors.map(({ name }) => name).join(', ')}\n`);
  }

  const [semantic, keyword] = await Promise.all([
    semanticSearch(semanticText, authorIds),
    keywordSearch(keywordText, authorIds),
  ]);
  const results = fuse(semantic, keyword);
  if (results.length === 0) {
    console.log('Nothing found. Have the conversations been summarized with /summarize?\n');
    return;
  }

  const details = await chunkDetails(results.map(({ id }) => id));
  results.forEach(({ id, semanticRank, keywordRank, bestMatch }, i) => {
    const chunk = details.get(id);
    if (!chunk) return;
    const ranks = [
      semanticRank && `meaning #${semanticRank}`,
      keywordRank && `keyword #${keywordRank}`,
    ].filter(Boolean);
    const date = chunk.startedAt.toISOString().slice(0, 10);
    console.log(`${i + 1}. #${chunk.channelName}, ${date}  [${ranks.join(', ')}]`);
    console.log(`   ${chunk.summary}`);
    if (bestMatch) console.log(`   > ${oneLine(bestMatch, 200)}`);
    console.log();
  });
}

try {
  const question = process.argv.slice(2).join(' ').trim();
  if (question) {
    await printResults(question);
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    for (;;) {
      const line = (await rl.question('Question (blank to quit): ')).trim();
      if (!line) break;
      await printResults(line);
    }
    rl.close();
  }
} finally {
  await pool.end();
}
