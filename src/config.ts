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

// Optional so the bot runs without it; creating embeddings throws if it's missing
export const voyageApiKey = process.env.VOYAGE_API_KEY;

// Claude models the bot can use, picked by name with SUMMARY_MODEL (summaries) and ANSWER_MODEL
// (/ask answers). The Anthropic SDK reads ANTHROPIC_API_KEY itself; it's only needed for those.
export interface ClaudeModel {
  id: string;
  // How hard the model thinks before answering; more effort costs more tokens
  effort: 'low' | 'medium' | 'high';
  // Whether the API may rerun a request on another model when this one declines it. Haiku has
  // no server-side fallback.
  fallbacks: boolean;
}

export const claudeModels = {
  opus: { id: 'claude-opus-5-5', effort: 'medium', fallbacks: true },
  sonnet: { id: 'claude-sonnet-5-5', effort: 'medium', fallbacks: true },
  haiku: { id: 'claude-haiku-5-5', effort: 'medium', fallbacks: false },
} satisfies Record<string, ClaudeModel>;

export type ClaudeModelName = keyof typeof claudeModels;

function isClaudeModelName(name: string): name is ClaudeModelName {
  return Object.hasOwn(claudeModels, name);
}

// Reads a model name from the environment, defaulting to opus; startup throws on a bad name
function modelFromEnv(envName: string): ClaudeModel {
  const name = process.env[envName] || 'opus';
  if (!isClaudeModelName(name)) {
    throw new Error(
      `${envName} must be one of ${Object.keys(claudeModels).join(', ')}, got "${name}"`,
    );
  }
  return claudeModels[name];
}

export const summaryModel = modelFromEnv('SUMMARY_MODEL');
export const answerModel = modelFromEnv('ANSWER_MODEL');

export const chunkingOptions: ChunkingOptions = {
  // Most messages a single chunk can hold
  messageLimit: intFromEnv('CHUNK_MESSAGE_LIMIT', 150),
  // Messages repeated from the end of a full chunk at the start of the next one
  overlap: intFromEnv('CHUNK_OVERLAP', 25),
  // Silence longer than this ends a conversation and starts a fresh chunk
  gapMinutes: intFromEnv('CONVERSATION_GAP_MINUTES', 60),
  // Conversations with fewer messages than this are dropped (e.g. a lone "gm")
  minMessages: intFromEnv('CONVERSATION_MIN_MESSAGES', 10),
};

if (chunkingOptions.messageLimit < 1) {
  throw new Error('CHUNK_MESSAGE_LIMIT must be at least 1');
}
if (chunkingOptions.overlap >= chunkingOptions.messageLimit) {
  throw new Error('CHUNK_OVERLAP must be smaller than CHUNK_MESSAGE_LIMIT');
}
