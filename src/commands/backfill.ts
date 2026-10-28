import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Message,
  type TextBasedChannel,
} from 'discord.js';
import { getBackfillCursor, saveMessages, upsertChannel, upsertGuild } from '../db.js';

const PAGE_SIZE = 100; // Discord's max per request

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

  await interaction.editReply(
    `Done — saved ${saved} new of ${fetched} fetched messages from #${channelName(channel)}` +
      `${cursor ? ' (resumed from the last backfill)' : ''}.`,
  );
}
