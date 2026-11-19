// /usage: shows a server what its /ask questions have cost, this month and all time, from the
// usage table. Only for members with Manage Server, and only the person who ran it sees the reply.
import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { usageTotals, type UsageTotals } from '../usage.js';

const COLOR = 0x5865f2;

export const data = new SlashCommandBuilder()
  .setName('usage')
  .setDescription("Show what this server's /ask questions have cost")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

// Midnight UTC on the first of this month
function startOfMonthUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function dollars(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toFixed(2)}`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

// "$1.23 for 45 questions", plus a line for questions with no known cost when there are any
function totalsText({ questions, costMicroUsd, unknownCost }: UsageTotals): string {
  const line = `${dollars(costMicroUsd)} for ${plural(questions, 'question')}`;
  if (unknownCost === 0) return line;
  return `${line}\n${plural(unknownCost, 'question')} with unknown cost (interrupted or unpriced)`;
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: '/usage only works in a server.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const monthStart = startOfMonthUtc();
  const [month, allTime] = await Promise.all([
    usageTotals(interaction.guildId, monthStart),
    usageTotals(interaction.guildId, null),
  ]);

  const monthName = monthStart.toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`/ask usage for ${interaction.guild.name}`)
    .addFields(
      { name: `This month (${monthName}, UTC)`, value: totalsText(month) },
      { name: 'All time', value: totalsText(allTime) },
    )
    .setFooter({ text: 'Claude API cost of answering questions; search costs are not included.' });
  await interaction.editReply({ embeds: [embed] });
}
