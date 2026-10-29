import { createHash } from 'node:crypto';
import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { ConversationChunker, textContent } from '../chunker.js';
import { chunkingOptions } from '../config.js';
import { authorNames, replaceChunks, storedMessages, type ChunkRow } from '../db.js';
import { formatChunkForSummarizing, type MentionNames } from '../embedding.js';

interface ChunkMessage {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: string;
}

// What buildChunks needs to print each chunk as it's built
export interface ChunkLog {
  channelName: string;
  names: MentionNames;
}

const RULE = '='.repeat(80);

// Prints a chunk as the transcript the summarizer will see, under a header with its position
// and size, so `npm run dev | tee chunks.log` gives a readable record of how a channel split:
//
//   ================================================================================
//   chunk 12 · 64 messages (20 carried over from chunk 11) · 1f3a9c2e
//   ================================================================================
//   Conversation in #general, 2022-05-26 05:35 to 2022-05-26 06:44 UTC
//
//   alice: did anyone see @bob's clip :POGGERS:
//   ...
function logChunk(
  index: number,
  overlap: number,
  messages: ChunkMessage[],
  row: ChunkRow,
  { channelName, names }: ChunkLog,
): void {
  const carried = overlap > 0 ? ` (${overlap} carried over from chunk ${index - 1})` : '';
  const transcript = formatChunkForSummarizing(
    { startedAt: new Date(row.startedAt), endedAt: new Date(row.endedAt), messages },
    names,
    channelName,
  );
  console.log(
    `${RULE}\nchunk ${index} · ${messages.length} messages${carried} · ${row.contentHash.slice(0, 8)}\n${RULE}\n${transcript}\n`,
  );
}

// Fingerprint of a chunk's messages. The same messages give the same hash on every run, which
// is how a rebuilt chunk is matched to the stored one. NUL separators keep text containing
// IDs or newlines from producing the same input as a different set of messages.
function contentHash(messages: ChunkMessage[]): string {
  const hash = createHash('sha256');
  for (const { id, content } of messages) hash.update(`${id}\0${content}\0`);
  return hash.digest('hex');
}

// Chunks a channel's saved messages, oldest first. Only the chunks' metadata is kept, so a
// large channel isn't held in memory. Returns the chunks and how many messages went into them.
// With `log`, each chunk is also printed as it's built.
export async function buildChunks(
  channelId: string,
  log?: ChunkLog,
): Promise<{ chunks: ChunkRow[]; messageCount: number }> {
  const chunks: ChunkRow[] = [];
  const chunker = new ConversationChunker<ChunkMessage>(
    chunkingOptions,
    async ({ messages, ...chunk }) => {
      const first = messages[0];
      const last = messages.at(-1);
      if (!first || !last) return;
      const row: ChunkRow = {
        firstMessageId: first.id,
        lastMessageId: last.id,
        startedAt: chunk.startedAt,
        endedAt: chunk.endedAt,
        contentHash: contentHash(messages),
      };
      chunks.push(row);
      if (log) logChunk(chunk.index, chunk.overlap, messages, row, log);
    },
  );

  let messageCount = 0;
  for await (const message of storedMessages(channelId)) {
    const content = textContent(message.content);
    if (!content) continue;
    await chunker.add({
      id: message.id,
      authorId: message.authorId,
      authorName: message.authorName,
      content,
      createdAt: message.createdAt.toISOString(),
    });
    messageCount++;
  }
  await chunker.flush();

  return { chunks, messageCount };
}

export const data = new SlashCommandBuilder()
  .setName('chunk')
  .setDescription("Split this channel's saved messages into conversation chunks")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: 'Chunking only works in server channels.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const { channel } = interaction;
  if (!channel) {
    await interaction.reply({
      content: "I can't read messages in this channel.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { chunks, messageCount } = await buildChunks(channel.id, {
    channelName: channel.name,
    names: { users: await authorNames(interaction.guildId) },
  });
  const { inserted, deleted } = await replaceChunks(channel.id, interaction.guildId, chunks);
  console.log(
    `[chunk] #${channel.name}: ${messageCount} messages → ${chunks.length} chunks ` +
      `(${inserted} new, ${deleted} removed)`,
  );

  if (messageCount === 0) {
    await interaction.editReply(
      `No saved messages in #${channel.name} yet — run /backfill here first.`,
    );
    return;
  }
  await interaction.editReply(
    `Done — chunked ${messageCount} text messages from #${channel.name} into ${chunks.length} chunks: ` +
      `${inserted} new, ${chunks.length - inserted} unchanged, ${deleted} removed.`,
  );
}
