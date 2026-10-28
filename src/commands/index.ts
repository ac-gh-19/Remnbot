import type { ChatInputCommandInteraction, SlashCommandOptionsOnlyBuilder } from 'discord.js';
import * as backfill from './backfill.js';
import * as chunk from './chunk.js';

export interface Command {
  data: Pick<SlashCommandOptionsOnlyBuilder, 'name' | 'toJSON'>;
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
}

export const commands = new Map<string, Command>(
  [backfill, chunk].map((command) => [command.data.name, command]),
);
