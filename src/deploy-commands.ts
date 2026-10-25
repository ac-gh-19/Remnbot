import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { commands } from './commands/index.js';

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  throw new Error('DISCORD_TOKEN, CLIENT_ID and GUILD_ID must be set');
}

const rest = new REST().setToken(DISCORD_TOKEN);
const body = [...commands.values()].map((command) => command.data.toJSON());

// Guild commands update instantly, unlike global commands
await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body });
console.log(`Registered ${body.length} command(s) in guild ${GUILD_ID}`);
