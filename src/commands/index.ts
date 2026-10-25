import type { ChatInputCommandInteraction, SlashCommandOptionsOnlyBuilder } from 'discord.js';
import * as backfill from './backfill.js';

export interface Command {
  data: Pick<SlashCommandOptionsOnlyBuilder, 'name' | 'toJSON'>;
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
}

export const commands = new Map<string, Command>(
  [backfill].map((command) => [command.data.name, command]),
);
