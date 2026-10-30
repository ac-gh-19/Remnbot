import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { summaryModel, type SummaryModel } from '../config.js';

const ENTITY_TYPES = [
  'person',
  'place',
  'organization',
  'game',
  'movie',
  'show',
  'music',
  'book',
  'product',
  'event',
  'other',
] as const;

const ConversationSummarySchema = z.object({
  summary: z.string(),
  topics: z.array(z.string()),
  entities: z.array(z.object({ name: z.string(), type: z.enum(ENTITY_TYPES) })),
  substance: z.enum(['low', 'medium', 'high']),
  outcome: z.string().nullable(),
});

export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

const SYSTEM_PROMPT = `You summarize Discord conversations so they can be searched and recalled later. You get a transcript with one message per line as "author: text". "(xN)" means the same message was sent N times in a row, and links appear as [link: site/path].

Return:
- summary: 2-5 sentences on what was discussed and who said what that mattered. Use people's names as they appear in the transcript. Write it so someone who wasn't there understands it.
- topics: the main subjects, as short lowercase phrases (e.g. "elden ring dlc", "weekend trip planning"). Leave out passing mentions.
- entities: the specific people, places and things named or clearly referred to: games, movies, shows, music, books, products, organizations, events. Include the conversation's participants only when the conversation is about them, not just because they spoke. One entry per entity, using its most complete name.
- substance: how much real content the conversation has. "low" for greetings, memes, reactions, spam or one-liners that go nowhere; "medium" for a real exchange on a subject without much depth or resolution; "high" for detailed discussion, useful information, plans or decisions.
- outcome: what the conversation came to, if anything, such as a decision the group made, a plan agreed on, a question answered or how things ended up. null when it just drifts off without one.

Only report what the transcript supports. Don't guess at things it doesn't say.`;

let client: Anthropic | undefined;

// Summarizes a conversation, along with its topics, the entities it mentions, how substantive
// it is and what it led to. `transcript` is a chunk as formatChunkForSummarizing renders it,
// which is the format SYSTEM_PROMPT describes.
export async function summarizeConversation(
  transcript: string,
  model: SummaryModel = summaryModel,
): Promise<ConversationSummary> {
  client ??= new Anthropic();

  const response = await client.beta.messages.parse({
    model: model.id,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: transcript }],
    output_config: { effort: model.effort, format: betaZodOutputFormat(ConversationSummarySchema) },
    ...(model.fallbacks && { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }),
  });

  if (response.stop_reason === 'refusal') {
    throw new Error(
      `${response.model} declined to summarize the conversation: ${response.stop_details?.explanation ?? 'no reason given'}`,
    );
  }
  if (!response.parsed_output) {
    throw new Error(
      `Summary from ${response.model} didn't match the schema (${response.stop_reason})`,
    );
  }
  return response.parsed_output;
}
