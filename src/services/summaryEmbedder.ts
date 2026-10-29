import { embed } from '../embedding.js';
import type { ConversationSummary } from './summarizer.js';

// Renders a summary as the text that gets embedded:
//
//   Summary: Alice asked who wanted to play Elden Ring Nightreign on Friday...
//   Topics: friday game night planning, elden ring nightreign
//   Mentions: Elden Ring Nightreign (game), Dune: Part Two (movie)
//   Outcome: Plan agreed for Friday: watch Dune Part Two at 6, then play Nightreign at 8.
//
// Topics, entities and outcome are included so a search for any of them lands on the
// conversation, even when the summary itself only mentions them in passing. Substance is left
// out; it's for filtering, not for matching what a conversation is about.
export function formatSummaryForEmbedding(summary: ConversationSummary): string {
  const lines = [`Summary: ${summary.summary}`];
  if (summary.topics.length > 0) lines.push(`Topics: ${summary.topics.join(', ')}`);
  if (summary.entities.length > 0) {
    const mentions = summary.entities.map(({ name, type }) => `${name} (${type})`);
    lines.push(`Mentions: ${mentions.join(', ')}`);
  }
  if (summary.outcome) lines.push(`Outcome: ${summary.outcome}`);
  return lines.join('\n');
}

// Embeds summaries in one request and returns one vector per summary, in the same order. They're
// embedded as documents, the side that gets searched over.
export async function embedSummaries(summaries: ConversationSummary[]): Promise<number[][]> {
  return embed(summaries.map(formatSummaryForEmbedding), 'document');
}
