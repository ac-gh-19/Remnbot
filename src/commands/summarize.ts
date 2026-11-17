import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import {
  authorNames,
  chunksMissingWindows,
  pendingChunks,
  recordSummaryFailure,
  saveChunkEmbeddings,
  saveChunkSummary,
  saveWindows,
  type PendingChunk,
  type WindowlessChunk,
} from '../db.js';
import {
  EMBEDDING_MODEL,
  embed,
  formatChunkForSummarizing,
  type MentionNames,
} from '../embedding.js';
import {
  isTransientError,
  summarizeConversation,
  type ConversationSummary,
} from '../services/summarizer.js';
import { chunkMessages } from '../retrieval.js';
import { embedSummaries } from '../services/summaryEmbedder.js';
import { buildWindows, type Window } from '../windows.js';

// Chunks summarized at the same time, and then embedded together in one request
const BATCH_SIZE = 8;
// A chunk whose summary has failed this many times is skipped from then on
const MAX_SUMMARY_ATTEMPTS = 3;
// Limits on one window-embedding request, well under Voyage's 1,000 texts and 320K tokens. A
// whole chunk's windows go in one request, so a request can only pass these if one chunk does.
const MAX_WINDOWS_PER_REQUEST = 500;
const MAX_WINDOW_CHARS_PER_REQUEST = 400_000;

interface BatchResult {
  summarized: number;
  embedded: number;
  failed: number;
}

// Summarizes a chunk from its saved messages. The channel name is left out of the transcript so
// the model doesn't open every summary with it.
async function summarizeChunk(
  channelId: string,
  chunk: PendingChunk,
  names: MentionNames,
): Promise<ConversationSummary> {
  const messages = await chunkMessages(channelId, chunk);
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

interface WindowedChunk {
  chunk: WindowlessChunk;
  windows: Window[];
}

// Embeds a batch of chunks' windows in one request and saves them. A failed request throws and
// stops the run: embed() has already retried rate limits and server errors for minutes, so
// whatever is wrong (a bad key, a used-up quota, an outage) would fail every batch after it.
async function embedWindowBatch(channelId: string, batch: WindowedChunk[]): Promise<void> {
  const windows = batch.flatMap(({ chunk, windows }) =>
    windows.map((window) => ({ chunkId: chunk.id, ...window })),
  );
  const embeddings = await embed(
    windows.map(({ text }) => text),
    'document',
  );
  await saveWindows(
    channelId,
    batch.map(({ chunk }) => chunk.id),
    windows.map(({ chunkId, firstMessageId, lastMessageId }, i) => {
      const embedding = embeddings[i];
      if (!embedding)
        throw new Error(`Voyage returned no embedding for a window of chunk ${chunkId}`);
      return { chunkId, firstMessageId, lastMessageId, embedding };
    }),
    EMBEDDING_MODEL,
  );
}

// The window pass: cuts every summarized chunk that has no current-model windows into windows,
// embeds them in batches and saves each batch before starting the next. Returns how many chunks
// and windows were embedded.
export async function embedWindows(
  channelId: string,
  names: MentionNames,
  channelName: string,
): Promise<{ chunks: number; windows: number }> {
  const totals = { chunks: 0, windows: 0 };
  let batch: WindowedChunk[] = [];
  let batchWindows = 0;
  let batchChars = 0;

  const run = async (): Promise<void> => {
    if (batch.length === 0) return;
    await embedWindowBatch(channelId, batch);
    totals.chunks += batch.length;
    totals.windows += batchWindows;
    console.log(
      `[summarize] #${channelName}: ${totals.windows} windows embedded for ${totals.chunks} chunks so far`,
    );
    batch = [];
    batchWindows = 0;
    batchChars = 0;
  };

  for await (const chunk of chunksMissingWindows(channelId, EMBEDDING_MODEL)) {
    const windows = buildWindows(await chunkMessages(channelId, chunk), names);
    const chars = windows.reduce((sum, { text }) => sum + text.length, 0);
    if (
      batchWindows + windows.length > MAX_WINDOWS_PER_REQUEST ||
      batchChars + chars > MAX_WINDOW_CHARS_PER_REQUEST
    ) {
      await run();
    }
    batch.push({ chunk, windows });
    batchWindows += windows.length;
    batchChars += chars;
  }
  await run();

  return totals;
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

  // Every chunk summarized so far, in this run or an earlier one, gets its windows
  const windows = await embedWindows(channel.id, names, channel.name);

  const message =
    totals.embedded === 0 && totals.failed === 0 && windows.chunks === 0
      ? `Nothing to summarize in #${channel.name} — every chunk is already embedded ` +
        `(or there are none yet: run /chunk here first).`
      : `Done — summarized ${totals.summarized} and embedded ${totals.embedded} chunks in #${channel.name}, ` +
        `plus ${windows.windows} message windows for ${windows.chunks} chunks` +
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
