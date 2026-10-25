import { mkdir, open, rm, writeFile } from 'node:fs/promises';
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

const PAGE_SIZE = 100; // Discord's max per request
const HISTORY_DIR = new URL('../../messageHistoryChannel/', import.meta.url);

// Channel names are usually safe already, but thread names can contain anything
function toFolderName(name: string): string {
  return name.replace(/[^\w.-]+/g, '-').replace(/^[-.]+|-+$/g, '') || 'unnamed';
}

// GIF hosts, plus any link straight to an image/video file (e.g. Discord attachment URLs)
const MEDIA_LINK =
  /https?:\/\/(?:(?:[\w-]+\.)*(?:tenor|giphy|klipy)\.com\/\S*|[^\s?#]+\.(?:gif|gifv|png|jpe?g|webp|mp4|mov)(?:[?#]\S*)?)/gi;

// The message's text with GIF/image links removed; empty if nothing informative is left
function textContent(message: Message): string {
  return message.content.replace(MEDIA_LINK, '').trim();
}

interface MessageRecord {
  id: string;
  author: string;
  content: string;
  createdAt: string;
}

function toRecord(message: Message): MessageRecord {
  return {
    id: message.id,
    author: message.author.tag,
    content: textContent(message),
    createdAt: message.createdAt.toISOString(),
  };
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

// Walks a channel's history from oldest to newest, calling onMessage for each message.
// Returns the total number of messages seen.
export async function fetchAllMessages(
  channel: TextBasedChannel,
  onMessage: (message: Message) => Promise<void>,
): Promise<number> {
  let after = '0'; // every message ID is greater than 0, so the first page is the oldest
  let total = 0;

  while (true) {
    const page = await channel.messages.fetch({ limit: PAGE_SIZE, after, cache: false });
    if (page.size === 0) break;

    // Discord returns each page newest-first, even when paging forward
    const batch = [...page.values()].sort(byIdAscending);
    const last = batch.at(-1);
    if (!last) break;
    for (const message of batch) {
      await onMessage(message);
    }

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
  const { channel } = interaction;
  if (!channel?.isTextBased()) {
    await interaction.reply({
      content: "I can't read messages in this channel.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Backfilling can take a while, so acknowledge within Discord's 3-second window first
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const folderName = toFolderName(channelName(channel));

  const channelDir = new URL(`${folderName}/`, HISTORY_DIR);
  await mkdir(channelDir, { recursive: true });

  // Each run replaces the previous output, so stale chunks from an older run don't linger
  const chunksDir = new URL('chunks/', channelDir);
  await rm(chunksDir, { recursive: true, force: true });
  await rm(new URL('chunks.jsonl', channelDir), { force: true }); // older single-file format
  await mkdir(chunksDir);

  // One JSON object per line, oldest first
  const messagesFile = await open(new URL('messages.jsonl', channelDir), 'w');
  // One file per chunk, e.g. chunks/00001.json, so they sort in order
  const chunker = new ConversationChunker<MessageRecord>(chunking, (chunk) =>
    writeFile(
      new URL(`${String(chunk.index).padStart(5, '0')}.json`, chunksDir),
      formatChunk(chunk),
    ),
  );

  let total: number;
  let saved = 0;
  try {
    total = await fetchAllMessages(channel, async (message) => {
      // Skip GIF/image-only messages (and attachment-only ones with no text)
      if (!textContent(message)) return;
      const record = toRecord(message);
      await messagesFile.write(JSON.stringify(record) + '\n');
      await chunker.add(record);
      saved++;
    });
    await chunker.flush();
  } finally {
    await messagesFile.close();
  }

  await interaction.editReply(
    `Done — saved ${saved} of ${total} messages from #${channelName(channel)} (skipped ${total - saved} GIF/image-only) ` +
      `into ${chunker.count} chunks in messageHistoryChannel/${folderName}/chunks/.`,
  );
}
