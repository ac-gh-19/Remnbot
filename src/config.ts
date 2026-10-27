import 'dotenv/config';
import type { ChunkingOptions } from './chunker.js';

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a whole number, got "${raw}"`);
  }
  return value;
}

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL must be set, e.g. postgres://localhost:5432/discord_bot');
}
export const databaseUrl = DATABASE_URL;

export const chunking: ChunkingOptions = {
  // Most messages a single chunk can hold
  messageLimit: intFromEnv('CHUNK_MESSAGE_LIMIT', 300),
  // Messages repeated from the end of a full chunk at the start of the next one
  overlap: intFromEnv('CHUNK_OVERLAP', 50),
  // Silence longer than this ends a conversation and starts a fresh chunk
  gapMinutes: intFromEnv('CONVERSATION_GAP_MINUTES', 60),
  // Conversations with fewer messages than this are dropped (e.g. a lone "gm")
  minMessages: intFromEnv('CONVERSATION_MIN_MESSAGES', 20),
};

if (chunking.messageLimit < 1) {
  throw new Error('CHUNK_MESSAGE_LIMIT must be at least 1');
}
if (chunking.overlap >= chunking.messageLimit) {
  throw new Error('CHUNK_OVERLAP must be smaller than CHUNK_MESSAGE_LIMIT');
}
