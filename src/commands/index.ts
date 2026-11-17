import type { ChatInputCommandInteraction, SlashCommandOptionsOnlyBuilder } from 'discord.js';
import * as ask from './ask.js';
import * as backfill from './backfill.js';
import * as chunk from './chunk.js';
import * as summarize from './summarize.js';

export interface Command {
  data: Pick<SlashCommandOptionsOnlyBuilder, 'name' | 'toJSON'>;
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
}

export const commands = new Map<string, Command>(
  [ask, backfill, chunk, summarize].map((command) => [command.data.name, command]),
);
