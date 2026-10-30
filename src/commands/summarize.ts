import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { textContent } from '../chunker.js';
import {
  authorNames,
  messagesBetween,
  pendingChunks,
  recordSummaryFailure,
  saveChunkEmbeddings,
  saveChunkSummary,
  type PendingChunk,
} from '../db.js';
import { EMBEDDING_MODEL, formatChunkForSummarizing, type MentionNames } from '../embedding.js';
import {
  isTransientError,
  summarizeConversation,
  type ConversationSummary,
} from '../services/summarizer.js';
import { embedSummaries } from '../services/summaryEmbedder.js';

// Chunks summarized at the same time, and then embedded together in one request
const BATCH_SIZE = 8;
// A chunk whose summary has failed this many times is skipped from then on
const MAX_SUMMARY_ATTEMPTS = 3;

interface BatchResult {
  summarized: number;
  embedded: number;
  failed: number;
}

// Summarizes a chunk from its saved messages, filtered the same way /chunk filtered them. The
// channel name is left out of the transcript so the model doesn't open every summary with it.
async function summarizeChunk(
  channelId: string,
  chunk: PendingChunk,
  names: MentionNames,
): Promise<ConversationSummary> {
  const messages = [];
  for (const message of await messagesBetween(
    channelId,
    chunk.firstMessageId,
    chunk.lastMessageId,
  )) {
    const content = textContent(message.content);
    if (content) messages.push({ ...message, content });
  }
  const transcript = formatChunkForSummarizing(
    { startedAt: chunk.startedAt, endedAt: chunk.endedAt, messages },
    names,
  );
  return summarizeConversation(transcript);
}

// Summarizes the chunks that don't have a summary yet, then embeds every chunk in the batch
// that has one. Each summary is saved as soon as it arrives, so if embedding fails the next run
// only has to embed. A failed summary is logged and counted, and the rest carry on.
async function processBatch(
  channelId: string,
  batch: PendingChunk[],
  names: MentionNames,
  channelName: string,
): Promise<BatchResult> {
  const result: BatchResult = { summarized: 0, embedded: 0, failed: 0 };

  const summaries = await Promise.all(
    batch.map(async (chunk) => {
      if (chunk.summary) return chunk.summary;
      try {
        const summary = await summarizeChunk(channelId, chunk, names);
        await saveChunkSummary(chunk.id, summary);
        result.summarized++;
        console.log(`[summarize] #${channelName}: chunk ${chunk.id} (${summary.substance})`);
        return summary;
      } catch (error) {
        // Only failures that point at the chunk itself count towards skipping it for good;
        // a rate limit or outage says nothing about whether it can be summarized
        if (!isTransientError(error)) await recordSummaryFailure(chunk.id);
        result.failed++;
        console.error(`[summarize] #${channelName}: chunk ${chunk.id} failed:`, error);
        return null;
      }
    }),
  );

  const ready = batch.flatMap((chunk, i) => {
    const summary = summaries[i];
    return summary ? [{ chunkId: chunk.id, summary }] : [];
  });
  const embeddings = await embedSummaries(ready.map(({ summary }) => summary));
  await saveChunkEmbeddings(
    ready.map(({ chunkId }, i) => {
      const embedding = embeddings[i];
      if (!embedding) throw new Error(`Voyage returned no embedding for chunk ${chunkId}`);
      return { chunkId, embedding };
    }),
    EMBEDDING_MODEL,
  );
  result.embedded = ready.length;

  return result;
}

export const data = new SlashCommandBuilder()
  .setName('summarize')
  .setDescription("Summarize and embed this channel's conversation chunks")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: 'Summarizing only works in server channels.',
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

  const names: MentionNames = { users: await authorNames(interaction.guildId) };
  const totals: BatchResult = { summarized: 0, embedded: 0, failed: 0 };
  const run = async (batch: PendingChunk[]): Promise<void> => {
    const { summarized, embedded, failed } = await processBatch(
      channel.id,
      batch,
      names,
      channel.name,
    );
    totals.summarized += summarized;
    totals.embedded += embedded;
    totals.failed += failed;
    console.log(
      `[summarize] #${channel.name}: ${totals.embedded} chunks embedded so far` +
        (totals.failed ? `, ${totals.failed} failed` : ''),
    );
  };

  let batch: PendingChunk[] = [];
  for await (const chunk of pendingChunks(channel.id, EMBEDDING_MODEL, MAX_SUMMARY_ATTEMPTS)) {
    batch.push(chunk);
    if (batch.length === BATCH_SIZE) {
      await run(batch);
      batch = [];
    }
  }
  if (batch.length > 0) await run(batch);

  const message =
    totals.embedded === 0 && totals.failed === 0
      ? `Nothing to summarize in #${channel.name} — every chunk is already embedded ` +
        `(or there are none yet: run /chunk here first).`
      : `Done — summarized ${totals.summarized} and embedded ${totals.embedded} chunks in #${channel.name}` +
        (totals.failed
          ? `. ${totals.failed} failed to summarize and will be retried next run ` +
            `(up to ${MAX_SUMMARY_ATTEMPTS} attempts each; rate limits and outages don't count).`
          : '.');
  console.log(`[summarize] ${message}`);

  // The interaction token expires 15 minutes after the command, and a big channel takes longer
  // than that. Everything is saved by now, so a reply that can't be sent is only logged.
  try {
    await interaction.editReply(message);
  } catch (error) {
    console.warn('[summarize] Could not reply; the interaction has probably expired:', error);
  }
}
