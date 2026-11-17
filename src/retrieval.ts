// The search behind `/ask`, `npm run search` and `npm run eval`: finds the conversations that best answer
// a question three ways (by summary embedding, by window embedding, by keyword over raw
// messages) and merges the three ranked lists with reciprocal rank fusion.
import { textContent } from './chunker.js';
import { authorNames, messagesBetween, pool, type StoredMessage } from './db.js';
import { EMBEDDING_MODEL, embed, formatTranscriptLines, type MentionNames } from './embedding.js';

export const RESULT_LIMIT = 10;
// How many of each search's best chunks are merged; a chunk ranked lower than this in one search
// can still make the results on the strength of the other
const CANDIDATE_LIMIT = 50;
// How many windows the window search fetches to find its CANDIDATE_LIMIT conversations. More than
// CANDIDATE_LIMIT, because one conversation often has several windows near the question.
const WINDOW_LIMIT = 150;
// Reciprocal rank fusion's damping constant: the smaller it is, the more a top rank in one search
// counts against middling ranks in both. The usual default is 60, which made a chunk ranked #9 and
// #34 beat one ranked #1 by keyword alone; with only 50 candidates each, the top of a list is
// what matters, so it's lower here. 5 and 10 scored about the same in `npm run eval`; 20 and 60
// were clearly worse.
export const RRF_K = 5;
// How much each search's ranks count in fuse. Summary ranks count fully; the others are scaled
// against them.
export interface Weights {
  summary: number;
  window: number;
  keyword: number;
}

// The weights below were picked with `npm run eval` for broad "when did we talk about X"
// questions, the best of 114 configurations on them. More keyword weight helps questions about a
// specific fact but hurts broad ones.
//
// How much a keyword rank counts next to a summary rank of the same number. Keyword matches are
// noisy (any message with a common word like "take" matches), so at 0.25 a keyword #1 alone
// scores like a summary #19: it mostly breaks ties between conversations the other searches found.
const KEYWORD_WEIGHT = 0.25;
// How much a window rank counts next to a summary rank of the same number. At 1 the two meaning
// searches count equally: summaries match what a conversation was about, windows the specific
// lines in it, and a conversation both rank highly beats one only a single search found.
const WINDOW_WEIGHT = 1;

export const DEFAULT_WEIGHTS: Weights = {
  summary: 1,
  window: WINDOW_WEIGHT,
  keyword: KEYWORD_WEIGHT,
};

// Matches the "@name" a question uses to mean a person
const MENTION = /@([\w.]+)/g;

export interface Author {
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

// Runs a nearest-neighbour query (ordered by an HNSW-indexed distance) in its own transaction.
// With an author filter, the HNSW index would otherwise find its usual ~40 nearest rows and then
// drop the ones that fail the filter, leaving too few. An iterative scan keeps walking the index
// until enough pass.
async function nearest<T extends object>(sql: string, params: unknown[]): Promise<T[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL hnsw.iterative_scan = strict_order`);
    const { rows } = await client.query<T>(sql, params);
    await client.query('COMMIT');
    return rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Only conversations where one of the authors ($3) wrote a message; c is the chunk
const AUTHOR_FILTER = `($3::bigint[] IS NULL OR EXISTS (
  SELECT 1 FROM messages m
  WHERE m.channel_id = c.channel_id
    AND m.id BETWEEN c.first_message_id AND c.last_message_id
    AND m.author_id = ANY($3)
))`;

// Only chunks in these channels ($5); null allows every channel. c is the chunk.
const CHANNEL_FILTER = `($5::bigint[] IS NULL OR c.channel_id = ANY($5))`;

// Who and where a search is limited to; null on either means no limit
interface SearchFilter {
  authorIds: string[] | null;
  channelIds: string[] | null;
}

// The chunks whose summary embeddings are closest to the question's, best first. Only rows
// embedded with the current model are compared, here and in windowSearch, since vectors from
// different models don't share a space.
async function summarySearch(
  vector: number[],
  { authorIds, channelIds }: SearchFilter,
): Promise<string[]> {
  const rows = await nearest<{ id: string }>(
    `SELECT c.id
     FROM chunks c
     WHERE c.embedding_model = $2 AND ${AUTHOR_FILTER} AND ${CHANNEL_FILTER}
     ORDER BY c.embedding <=> $1::vector
     LIMIT $4`,
    [JSON.stringify(vector), EMBEDDING_MODEL, authorIds, CANDIDATE_LIMIT, channelIds],
  );
  return rows.map(({ id }) => id);
}

export interface WindowRange {
  channelId: string;
  firstMessageId: string;
  lastMessageId: string;
}

export interface WindowHit {
  id: string;
  // The conversation's window nearest the question, to show why it was found
  window: WindowRange;
}

// The chunks with a window close to the question's embedding, best first, each ranked by its
// nearest window. Fetches the WINDOW_LIMIT nearest windows and keeps each chunk the first time
// one of its windows appears, up to CANDIDATE_LIMIT chunks. The author filter is the summary
// search's: the person wrote somewhere in the conversation, not necessarily in the window.
async function windowSearch(
  vector: number[],
  { authorIds, channelIds }: SearchFilter,
): Promise<WindowHit[]> {
  const rows = await nearest<WindowRange & { chunkId: string }>(
    `SELECT w.chunk_id AS "chunkId", w.channel_id AS "channelId",
            w.first_message_id AS "firstMessageId", w.last_message_id AS "lastMessageId"
     FROM windows w
     JOIN chunks c ON c.id = w.chunk_id
     WHERE w.embedding_model = $2 AND c.summary IS NOT NULL
       AND ${AUTHOR_FILTER} AND ${CHANNEL_FILTER}
     ORDER BY w.embedding <=> $1::vector
     LIMIT $4`,
    [JSON.stringify(vector), EMBEDDING_MODEL, authorIds, WINDOW_LIMIT, channelIds],
  );

  const hits = new Map<string, WindowHit>();
  for (const { chunkId, ...window } of rows) {
    if (hits.size === CANDIDATE_LIMIT) break;
    if (!hits.has(chunkId)) hits.set(chunkId, { id: chunkId, window });
  }
  return [...hits.values()];
}

export interface KeywordHit {
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
// matching messages. When authors are given, only their messages are searched; when channels are,
// only messages in them.
async function keywordSearch(
  text: string,
  { authorIds, channelIds }: SearchFilter,
): Promise<KeywordHit[]> {
  const { rows } = await pool.query<KeywordHit>(
    `WITH query AS (
       SELECT replace(websearch_to_tsquery('english', $1)::text, ' & ', ' | ')::tsquery AS q
     ), hits AS (
       SELECT m.channel_id, m.id, m.author_name, m.content, ts_rank(m.search_tsv, query.q) AS rank
       FROM messages m, query
       WHERE m.search_tsv @@ query.q
         AND m.deleted_at IS NULL AND NOT m.author_is_bot
         AND ($2::bigint[] IS NULL OR m.author_id = ANY($2))
         AND ($4::bigint[] IS NULL OR m.channel_id = ANY($4))
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
    [text, authorIds, CANDIDATE_LIMIT, channelIds],
  );
  return rows;
}

export interface FusedResult {
  id: string;
  score: number;
  summaryRank?: number;
  windowRank?: number;
  keywordRank?: number;
  window?: WindowRange;
  bestMatch?: string;
}

// Each search's ranked chunks for one question, before they're merged
export interface SearchLists {
  // Only conversations these people wrote in were searched; null when the question had no @name
  authors: Author[] | null;
  summary: string[];
  windows: WindowHit[];
  keyword: KeywordHit[];
}

// Runs the summary, window and keyword searches for a question. The question is embedded once
// and its vector shared by the summary and window searches. `channelIds` limits all three
// searches to those channels (/ask passes the ones the asker can view); null searches every
// channel.
export async function searchLists(
  question: string,
  channelIds: string[] | null = null,
): Promise<SearchLists> {
  const { semanticText, keywordText, authors } = await parseQuestion(question);
  const filter: SearchFilter = { authorIds: authors?.map(({ id }) => id) ?? null, channelIds };

  const [vector] = await embed([semanticText], 'query');
  if (!vector) throw new Error('Voyage returned no embedding for the question');
  const [summary, windows, keyword] = await Promise.all([
    summarySearch(vector, filter),
    windowSearch(vector, filter),
    keywordSearch(keywordText, filter),
  ]);
  return { authors, summary, windows, keyword };
}

// Reciprocal rank fusion: each search gives a chunk 1 / (RRF_K + rank) points, scaled by that
// search's weight, and the points are added up. Only ranks are used, not the searches' own
// scores, which aren't on comparable scales (summary vs window cosine similarity, ts_rank). A
// chunk several searches found beats one only a single search ranked a little higher. A search
// with weight 0 is left out entirely, so its ranks don't show on results either. Returns the best
// `limit` chunks.
export function fuse(
  { summary, windows, keyword }: SearchLists,
  weights: Weights = DEFAULT_WEIGHTS,
  limit = RESULT_LIMIT,
): FusedResult[] {
  const results = new Map<string, FusedResult>();
  const entry = (id: string) => {
    let result = results.get(id);
    if (!result) results.set(id, (result = { id, score: 0 }));
    return result;
  };
  const points = (weight: number, i: number) => weight / (RRF_K + i + 1);

  if (weights.summary > 0) {
    summary.forEach((id, i) => {
      const result = entry(id);
      result.summaryRank = i + 1;
      result.score += points(weights.summary, i);
    });
  }
  if (weights.window > 0) {
    windows.forEach(({ id, window }, i) => {
      const result = entry(id);
      result.windowRank = i + 1;
      result.window = window;
      result.score += points(weights.window, i);
    });
  }
  if (weights.keyword > 0) {
    keyword.forEach(({ id, bestMatch }, i) => {
      const result = entry(id);
      result.keywordRank = i + 1;
      result.bestMatch = bestMatch;
      result.score += points(weights.keyword, i);
    });
  }

  return [...results.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

export interface ChunkDetails {
  id: string;
  guildId: string;
  channelId: string;
  channelName: string;
  firstMessageId: string;
  lastMessageId: string;
  startedAt: Date;
  endedAt: Date;
  summary: string;
}

export async function chunkDetails(ids: string[]): Promise<Map<string, ChunkDetails>> {
  const { rows } = await pool.query<ChunkDetails>(
    `SELECT c.id, c.guild_id AS "guildId", c.channel_id AS "channelId", ch.name AS "channelName",
            c.first_message_id AS "firstMessageId", c.last_message_id AS "lastMessageId",
            c.started_at AS "startedAt", c.ended_at AS "endedAt", c.summary
     FROM chunks c
     JOIN channels ch ON ch.id = c.channel_id
     WHERE c.id = ANY($1::bigint[])`,
    [ids],
  );
  return new Map(rows.map((row) => [row.id, row]));
}

// Each guild's author names, for labelling window messages the way the summarizer saw them.
// Loaded once per guild per run.
const guildNames = new Map<string, Promise<MentionNames>>();
export function namesFor(guildId: string): Promise<MentionNames> {
  let names = guildNames.get(guildId);
  if (!names) {
    names = authorNames(guildId).then((users) => ({ users }));
    guildNames.set(guildId, names);
  }
  return names;
}

// A chunk's (or window's) saved messages, filtered the same way /chunk filtered them: no bots
// (messagesBetween skips them) and no messages that are only GIFs, images or attachments
export async function chunkMessages(
  channelId: string,
  { firstMessageId, lastMessageId }: { firstMessageId: string; lastMessageId: string },
): Promise<StoredMessage[]> {
  const messages = [];
  for (const message of await messagesBetween(channelId, firstMessageId, lastMessageId)) {
    const content = textContent(message.content);
    if (content) messages.push({ ...message, content });
  }
  return messages;
}

// A window's messages as transcript lines, filtered the way they were when it was embedded
export async function windowLines(window: WindowRange, guildId: string): Promise<string[]> {
  const messages = await chunkMessages(window.channelId, window);
  return formatTranscriptLines(messages, await namesFor(guildId));
}
