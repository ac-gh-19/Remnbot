import { createHash } from 'node:crypto';
import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { ConversationChunker, textContent } from '../chunker.js';
import { chunkingOptions } from '../config.js';
import { replaceChunks, storedMessages, type ChunkRow } from '../db.js';

interface ChunkMessage {
  id: string;
  content: string;
  createdAt: string;
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
export async function buildChunks(
  channelId: string,
): Promise<{ chunks: ChunkRow[]; messageCount: number }> {
  const chunks: ChunkRow[] = [];
  const chunker = new ConversationChunker<ChunkMessage>(
    chunkingOptions,
    async ({ messages, ...chunk }) => {
      const first = messages[0];
      const last = messages.at(-1);
      if (!first || !last) return;
      chunks.push({
        firstMessageId: first.id,
        lastMessageId: last.id,
        startedAt: chunk.startedAt,
        endedAt: chunk.endedAt,
        contentHash: contentHash(messages),
      });
    },
  );

  let messageCount = 0;
  for await (const message of storedMessages(channelId)) {
    const content = textContent(message.content);
    if (!content) continue;
    await chunker.add({ id: message.id, content, createdAt: message.createdAt.toISOString() });
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

  const { chunks, messageCount } = await buildChunks(channel.id);
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
