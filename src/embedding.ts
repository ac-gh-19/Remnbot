import { voyageApiKey } from './config.js';

// Changing either means re-embedding everything, and the dimension has to match the pgvector
// column, so these are constants rather than settings
export const EMBEDDING_MODEL = 'voyage-4';
export const EMBEDDING_DIMENSIONS = 1024;

// A message as read from the messages table. authorName is the name when it was sent;
// transcripts label the author by their latest name instead, found through authorId.
export interface ChatMessage {
  authorId: string;
  authorName: string;
  content: string;
}

// A chunk as read from the chunks table, with its messages loaded. pg returns timestamptz
// columns as Dates.
export interface Conversation {
  startedAt: Date;
  endedAt: Date;
  messages: ChatMessage[];
}

// Names to put in place of Discord's raw <@id>, <@&id> and <#id> markup. users also labels
// each message's author, so a renamed person goes by one name throughout a transcript.
export interface MentionNames {
  users: ReadonlyMap<string, string>;
  roles?: ReadonlyMap<string, string>;
  channels?: ReadonlyMap<string, string>;
}

const USER_MENTION = /<@!?(\d+)>/g;
const ROLE_MENTION = /<@&(\d+)>/g;
const CHANNEL_MENTION = /<#(\d+)>/g;
const CUSTOM_EMOJI = /<a?:(\w+):\d+>/g;
const LINK = /https?:\/\/[^\s<>]+/g;

// Keeps the site and path, which say what was shared, and drops tracking/query noise
function shortenLink(link: string): string {
  try {
    const { hostname, pathname } = new URL(link);
    const path = pathname.replace(/\/+$/, '');
    return `[link: ${hostname.replace(/^www\./, '')}${path}]`;
  } catch {
    return '[link]';
  }
}

// Message text with Discord markup turned into words, on a single line
function readableContent(content: string, names: MentionNames): string {
  return content
    .replace(USER_MENTION, (_, id: string) => `@${names.users.get(id) ?? 'someone'}`)
    .replace(ROLE_MENTION, (_, id: string) => `@${names.roles?.get(id) ?? 'role'}`)
    .replace(CHANNEL_MENTION, (_, id: string) => `#${names.channels?.get(id) ?? 'channel'}`)
    .replace(CUSTOM_EMOJI, ':$1:')
    .replace(LINK, shortenLink)
    .replace(/\s+/g, ' ')
    .trim();
}

// "2022-05-26 05:35"
const minute = (date: Date): string => date.toISOString().slice(0, 16).replace('T', ' ');

// Renders messages as transcript lines, one per message, so speaker turns stay clear:
//
//   alice: did anyone see @bob's clip :POGGERS:
//   bob: [link: youtube.com/watch]
//   carol: @everyone (x7)
//
// Authors go by their latest name. A run of identical messages from the same person (ping
// spam, copy-paste) becomes one line with a count instead of drowning out the rest. Shared by
// summary transcripts and windows, so both name people and links the same way.
export function formatTranscriptLines(messages: ChatMessage[], names: MentionNames): string[] {
  const turns: { author: string; text: string; count: number }[] = [];
  for (const message of messages) {
    const text = readableContent(message.content, names);
    if (!text) continue;

    const author = names.users.get(message.authorId) ?? message.authorName;
    const last = turns.at(-1);
    if (last && last.author === author && last.text === text) {
      last.count++;
    } else {
      turns.push({ author, text, count: 1 });
    }
  }
  return turns.map(
    ({ author, text, count }) => `${author}: ${text}${count > 1 ? ` (x${count})` : ''}`,
  );
}

// Renders a chunk as a plain transcript for the LLM that summarizes it: a header line, a blank
// line, then formatTranscriptLines:
//
//   Conversation in #general, 2022-05-26 05:35 to 2022-05-26 06:44 UTC
//
//   alice: did anyone see @bob's clip :POGGERS:
//   ...
export function formatChunkForSummarizing(
  conversation: Conversation,
  names: MentionNames,
  channelName?: string,
): string {
  const where = channelName ? ` in #${channelName}` : '';
  const header = `Conversation${where}, ${minute(conversation.startedAt)} to ${minute(conversation.endedAt)} UTC`;
  const lines = formatTranscriptLines(conversation.messages, names);
  return `${header}\n\n${lines.join('\n')}`;
}

// 'document' for text that's stored and searched over, 'query' for the question searched with.
// Voyage prefixes each with a different instruction, so questions land near the passages
// that answer them.
export type InputType = 'document' | 'query';

interface VoyageResponse {
  data: { embedding: number[]; index: number }[];
}

// Rate limits and server errors are retried this many times before embed gives up
const MAX_RETRIES = 6;
// Waits double from this after each failure, unless the response says how long to wait
const BASE_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60_000;

// How long to wait before retrying: the Retry-After header if there is one (in seconds),
// otherwise an exponential backoff.
function retryDelay(response: Response, retry: number): number {
  const retryAfter = Number(response.headers.get('retry-after'));
  if (retryAfter > 0) return Math.min(retryAfter * 1000, MAX_RETRY_DELAY_MS);
  return Math.min(BASE_RETRY_DELAY_MS * 2 ** retry, MAX_RETRY_DELAY_MS);
}

// Embeds texts in a single request (voyage-4 takes up to 1,000 texts and 320K tokens per
// request) and returns one vector per text, in the same order. A text longer than the model's
// context length is cut off rather than rejected. Rate limits (429) and server errors (5xx)
// are retried after a wait; any other error is thrown straight away.
export async function embed(texts: string[], inputType: InputType): Promise<number[][]> {
  if (!voyageApiKey) throw new Error('VOYAGE_API_KEY must be set to create embeddings');
  if (texts.length === 0) return [];

  for (let retry = 0; ; retry++) {
    // The key is a MongoDB Atlas key, which only works on Atlas's endpoint, not api.voyageai.com
    const response = await fetch('https://ai.mongodb.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${voyageApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: texts,
        model: EMBEDDING_MODEL,
        input_type: inputType,
        output_dimension: EMBEDDING_DIMENSIONS,
      }),
    });
    if (response.ok) {
      const { data } = (await response.json()) as VoyageResponse;
      return data.sort((a, b) => a.index - b.index).map(({ embedding }) => embedding);
    }

    const body = await response.text();
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || retry === MAX_RETRIES) {
      throw new Error(`Voyage embeddings failed (${response.status}): ${body}`);
    }
    const delay = retryDelay(response, retry);
    console.warn(
      `[embed] Voyage returned ${response.status}; retrying in ${delay / 1000}s ` +
        `(${retry + 1}/${MAX_RETRIES})`,
    );
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
