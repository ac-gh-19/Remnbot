import type { Chunk } from './chunker.js';

export interface ChatMessage {
  author: string;
  content: string;
  createdAt: string;
}

// Names to put in place of Discord's raw <@id>, <@&id> and <#id> markup
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
const minute = (iso: string): string => iso.slice(0, 16).replace('T', ' ');

// Renders a chunk as a plain transcript for the embedding model:
//
//   Conversation in #general, 2022-05-26 05:35 to 2022-05-26 06:44 UTC
//
//   alice: did anyone see @bob's clip :POGGERS:
//   bob: [link: youtube.com/watch]
//   carol: @everyone (x7)
//
// One line per message, so speaker turns stay clear. A run of identical messages from the
// same person (ping spam, copy-paste) becomes one line with a count instead of drowning out
// the rest of the conversation.
export function formatChunkForEmbedding(
  chunk: Chunk<ChatMessage>,
  names: MentionNames,
  channelName?: string,
): string {
  const turns: { author: string; text: string; count: number }[] = [];
  for (const message of chunk.messages) {
    const text = readableContent(message.content, names);
    if (!text) continue;

    const last = turns.at(-1);
    if (last && last.author === message.author && last.text === text) {
      last.count++;
    } else {
      turns.push({ author: message.author, text, count: 1 });
    }
  }

  const where = channelName ? ` in #${channelName}` : '';
  const header = `Conversation${where}, ${minute(chunk.startedAt)} to ${minute(chunk.endedAt)} UTC`;
  const lines = turns.map(
    ({ author, text, count }) => `${author}: ${text}${count > 1 ? ` (x${count})` : ''}`,
  );
  return `${header}\n\n${lines.join('\n')}`;
}
