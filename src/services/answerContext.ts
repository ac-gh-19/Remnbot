// Turns /ask's fused search results into the context document Claude answers from. The best few
// conversations go in whole; the rest as their summary plus the lines that matched the question.
import { formatChunkForSummarizing } from '../embedding.js';
import {
  chunkDetails,
  chunkMessages,
  namesFor,
  windowLines,
  type ChunkDetails,
  type FusedResult,
} from '../retrieval.js';

// How many of the best results go in as full transcripts; the rest go in as summaries
const FULL_TRANSCRIPTS = 3;

// A conversation in the context, labelled [source N], with what the Sources list links to
export interface AnswerSource {
  number: number;
  guildId: string;
  channelId: string;
  channelName: string;
  firstMessageId: string;
  startedAt: Date;
}

export interface AnswerContext {
  // Every source's text, separated by blank lines, ready to wrap in <conversations>
  text: string;
  sources: AnswerSource[];
}

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function label(number: number, chunk: ChunkDetails): string {
  return `[source ${number}] #${chunk.channelName}, ${day(chunk.startedAt)}`;
}

// The whole conversation, in the line format the summarizer gets
async function fullSource(number: number, chunk: ChunkDetails): Promise<string> {
  const messages = await chunkMessages(chunk.channelId, chunk);
  const transcript = formatChunkForSummarizing(
    { startedAt: chunk.startedAt, endedAt: chunk.endedAt, messages },
    await namesFor(chunk.guildId),
  );
  return `${label(number, chunk)}\n${transcript}`;
}

// The conversation's summary, plus its window nearest the question and its best keyword match
// when the searches found them
async function summarySource(
  number: number,
  chunk: ChunkDetails,
  { window, bestMatch }: FusedResult,
): Promise<string> {
  const parts = [label(number, chunk), `Summary: ${chunk.summary}`];
  if (window) {
    const lines = await windowLines(window, chunk.guildId);
    if (lines.length > 0) parts.push(`Lines closest to the question:\n${lines.join('\n')}`);
  }
  if (bestMatch) parts.push(`Best keyword match:\n${bestMatch}`);
  return parts.join('\n');
}

// Builds the context from results ordered best first. Results whose chunk has gone (a /chunk run
// since the search) are skipped, and the rest are numbered from 1 in order.
export async function buildAnswerContext(results: FusedResult[]): Promise<AnswerContext> {
  const details = await chunkDetails(results.map(({ id }) => id));
  const found = results.flatMap((result) => {
    const chunk = details.get(result.id);
    return chunk ? [{ result, chunk }] : [];
  });

  const texts = await Promise.all(
    found.map(({ result, chunk }, i) =>
      i < FULL_TRANSCRIPTS ? fullSource(i + 1, chunk) : summarySource(i + 1, chunk, result),
    ),
  );
  const sources = found.map(({ chunk }, i) => ({
    number: i + 1,
    guildId: chunk.guildId,
    channelId: chunk.channelId,
    channelName: chunk.channelName,
    firstMessageId: chunk.firstMessageId,
    startedAt: chunk.startedAt,
  }));
  return { text: texts.join('\n\n'), sources };
}
