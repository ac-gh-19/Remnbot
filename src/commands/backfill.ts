import { mkdir, rm, writeFile } from 'node:fs/promises';
import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Message,
  type TextBasedChannel,
} from 'discord.js';
import { ConversationChunker, type Chunk } from '../chunker.js';
import { chunking } from '../config.js';
import {
  getBackfillCursor,
  saveMessages,
  storedMessages,
  upsertChannel,
  upsertGuild,
} from '../db.js';

const PAGE_SIZE = 100; // Discord's max per request
const HISTORY_DIR = new URL('../../messageHistoryChannel/', import.meta.url);

// Channel names are usually safe already, but thread names can contain anything
function toFolderName(name: string): string {
  return name.replace(/[^\w.-]+/g, '-').replace(/^[-.]+|-+$/g, '') || 'unnamed';
}

// GIF hosts, plus any link straight to an image/video file (e.g. Discord attachment URLs)
const MEDIA_LINK =
  /https?:\/\/(?:(?:[\w-]+\.)*(?:tenor|giphy|klipy)\.com\/\S*|[^\s?#]+\.(?:gif|gifv|png|jpe?g|webp|mp4|mov)(?:[?#]\S*)?)/gi;

// The text with GIF/image links removed; empty if nothing informative is left
function textContent(content: string): string {
  return content.replace(MEDIA_LINK, '').trim();
}

interface MessageRecord {
  id: string;
  author: string;
  content: string;
  createdAt: string;
}

// Pretty-prints a chunk with one message per line, so files stay readable but not huge
function formatChunk({ messages, ...meta }: Chunk<MessageRecord>): string {
  const fields = Object.entries(meta).map(
    ([key, value]) => `  "${key}": ${JSON.stringify(value)},`,
  );
  const lines = messages.map((message) => `    ${JSON.stringify(message)}`);
  return `{\n${fields.join('\n')}\n  "messages": [\n${lines.join(',\n')}\n  ]\n}\n`;
}

// DMs and group DMs may have no name, so fall back to the channel ID
function channelName(channel: TextBasedChannel): string {
  return ('name' in channel && channel.name) || channel.id;
}

// Message IDs are snowflakes, which increase over time, so sorting by ID sorts by age
const byIdAscending = (a: Message, b: Message): number => (BigInt(a.id) < BigInt(b.id) ? -1 : 1);

// Walks a channel's history from oldest to newest, starting after the message ID `after`,
// calling onPage with each page of messages (oldest first). Returns the total number seen.
export async function fetchAllMessages(
  channel: TextBasedChannel,
  after: string,
  onPage: (messages: Message[]) => Promise<void>,
): Promise<number> {
  let total = 0;

  while (true) {
    const page = await channel.messages.fetch({ limit: PAGE_SIZE, after, cache: false });
    if (page.size === 0) break;

    // Discord returns each page newest-first, even when paging forward
    const batch = [...page.values()].sort(byIdAscending);
    const last = batch.at(-1);
    if (!last) break;
    await onPage(batch);

    total += batch.length;
    after = last.id;
    console.log(`[backfill] #${channelName(channel)}: ${total} messages so far`);

    if (batch.length < PAGE_SIZE) break;
  }

  return total;
}

export const data = new SlashCommandBuilder()
  .setName('backfill')
  .setDescription('Read through every message in this channel')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: 'Backfill only works in server channels.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const { channel, guild } = interaction;
  if (!channel) {
    await interaction.reply({
      content: "I can't read messages in this channel.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Backfilling can take a while, so acknowledge within Discord's 3-second window first
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  await upsertGuild(guild);
  await upsertChannel(channel);

  // Pick up after the last saved message, so a re-run only fetches what's new
  const cursor = await getBackfillCursor(channel.id);
  let saved = 0;
  const fetched = await fetchAllMessages(channel, cursor ?? '0', async (messages) => {
    saved += await saveMessages(channel.id, messages);
  });

  // Chunks are rebuilt from every saved message, so each run replaces the previous output
  const folderName = toFolderName(channelName(channel));
  const channelDir = new URL(`${folderName}/`, HISTORY_DIR);
  const chunksDir = new URL('chunks/', channelDir);
  await rm(chunksDir, { recursive: true, force: true });
  await rm(new URL('messages.jsonl', channelDir), { force: true }); // replaced by the database
  await mkdir(chunksDir, { recursive: true });

  // One file per chunk, e.g. chunks/00001.json, so they sort in order
  const chunker = new ConversationChunker<MessageRecord>(chunking, (chunk) =>
    writeFile(
      new URL(`${String(chunk.index).padStart(5, '0')}.json`, chunksDir),
      formatChunk(chunk),
    ),
  );

  let chunked = 0;
  for await (const message of storedMessages(channel.id)) {
    // Skip GIF/image-only messages (and attachment-only ones with no text)
    const content = textContent(message.content);
    if (!content) continue;
    await chunker.add({
      id: message.id,
      author: message.authorName,
      content,
      createdAt: message.createdAt.toISOString(),
    });
    chunked++;
  }
  await chunker.flush();

  await interaction.editReply(
    `Done — saved ${saved} new of ${fetched} fetched messages from #${channelName(channel)}` +
      `${cursor ? ' (resumed from the last backfill)' : ''}. ` +
      `Chunked ${chunked} text messages into ${chunker.count} chunks in messageHistoryChannel/${folderName}/chunks/.`,
  );
}
