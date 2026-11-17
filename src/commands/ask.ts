// /ask: answers a question from the chat archive. Searches the conversations the asker can see,
// has Claude write an overview from the best ones, and posts it publicly with links to them. One
// question is answered at a time, across the whole bot.
import {
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import { currentHolder, release, tryAcquire } from '../askLock.js';
import { archivedChannels, authorNames } from '../db.js';
import { fuse, searchLists } from '../retrieval.js';
import { buildAnswerContext, type AnswerSource } from '../services/answerContext.js';
import { AnswerError, answerQuestion } from '../services/answerer.js';
import { isTransientError } from '../services/summarizer.js';

const QUESTION_MAX_LENGTH = 300;
// Longest an answer may take before the Claude call is cancelled and a timeout error posted.
// Well inside the 15 minutes Discord allows for editing the deferred reply.
const TIMEOUT_MS = 3 * 60 * 1000;
// Discord's limit on an embed's main text
const DESCRIPTION_LIMIT = 4096;

const COLORS = { answer: 0x5865f2, notice: 0x99aab5, error: 0xed4245 };

// Nobody is pinged by anything /ask posts
const NO_PINGS = { allowedMentions: { parse: [] } } as const;

export const data = new SlashCommandBuilder()
  .setName('ask')
  .setDescription("Ask a question about the server's past conversations")
  .addStringOption((option) =>
    option
      .setName('question')
      .setDescription('What you want to know')
      .setRequired(true)
      .setMaxLength(QUESTION_MAX_LENGTH),
  );

// Raised when the 3-minute limit runs out, so the error embed can say so
class AskTimeoutError extends Error {
  constructor() {
    super(`Answering took longer than ${TIMEOUT_MS / 1000} seconds`);
    this.name = 'AskTimeoutError';
  }
}

// The archived channels and threads the member can read: a channel still in the server where
// they have View Channel and Read Message History, or a thread whose parent channel is one.
// Channels deleted since they were archived aren't in the guild's cache, so they're left out.
async function visibleChannelIds(member: GuildMember): Promise<string[]> {
  const canRead = (channelId: string) => {
    const channel = member.guild.channels.cache.get(channelId);
    return (
      channel
        ?.permissionsFor(member)
        .has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]) ?? false
    );
  };
  const channels = await archivedChannels(member.guild.id);
  return channels.filter(({ id, parentId }) => canRead(parentId ?? id)).map(({ id }) => id);
}

// Turns <@id> mentions into @name, using the person's latest name in the archive (or their
// current username if they never posted), so the search's @name author filter applies to them
async function mentionsToNames(question: string, member: GuildMember): Promise<string> {
  if (!/<@!?\d+>/.test(question)) return question;
  const names = await authorNames(member.guild.id);
  return question.replace(/<@!?(\d+)>/g, (mention, id: string) => {
    const name = names.get(id) ?? member.guild.members.cache.get(id)?.user.tag;
    return name ? `@${name}` : mention;
  });
}

// "@asker asked:" and the question as a quote, which opens every reply but the busy notice
function askedHeader(asker: string, question: string): string {
  return `**@${asker} asked:**\n> ${question}\n\n`;
}

// Cuts text to at most `max` characters at the end of the last line that fits, adding "…"
function fitLines(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = text.slice(0, Math.max(0, max - 1));
  const lastBreak = room.lastIndexOf('\n');
  return `${(lastBreak > 0 ? room.slice(0, lastBreak) : room).trimEnd()}…`;
}

function sourceLine({ guildId, channelId, channelName, firstMessageId, startedAt }: AnswerSource) {
  const url = `https://discord.com/channels/${guildId}/${channelId}/${firstMessageId}`;
  return `• [#${channelName}, ${startedAt.toISOString().slice(0, 10)}](${url})`;
}

// One embed: the header, the body (cut to fit), then the Sources list if there is one
function replyEmbed(
  color: number,
  header: string,
  body: string,
  sources: AnswerSource[] = [],
): EmbedBuilder {
  const footer = sources.length > 0 ? `\n\n**Sources**\n${sources.map(sourceLine).join('\n')}` : '';
  const room = DESCRIPTION_LIMIT - header.length - footer.length;
  return new EmbedBuilder().setColor(color).setDescription(header + fitLines(body, room) + footer);
}

// The one-line reason an error embed gives
function errorReason(error: unknown): string {
  if (error instanceof AskTimeoutError) {
    return 'That took too long to answer, so I stopped. Try again in a minute.';
  }
  if (isTransientError(error)) return 'Claude is busy right now. Try again in a minute.';
  if (error instanceof AnswerError && error.reason === 'refusal') {
    return 'Something went wrong: Claude declined to answer this question.';
  }
  return 'Something went wrong while answering this question.';
}

// Search → context → Claude. Returns the embed to post. Every step stops when `signal` aborts.
async function answer(
  question: string,
  member: GuildMember,
  header: string,
  signal: AbortSignal,
): Promise<EmbedBuilder> {
  const results = fuse(await searchLists(question, await visibleChannelIds(member)));
  signal.throwIfAborted();
  if (results.length === 0) {
    console.log('[ask] No search results; Claude not called');
    return replyEmbed(COLORS.notice, header, "I couldn't find any conversations about this.");
  }

  const context = await buildAnswerContext(results);
  signal.throwIfAborted();
  const { overview, sourcesUsed, answerable } = await answerQuestion(
    question,
    context.text,
    signal,
  );
  if (!answerable) {
    console.log('[ask] Claude found no answer in the sources');
    return replyEmbed(COLORS.notice, header, overview);
  }
  const used = new Set(sourcesUsed);
  const sources = context.sources.filter(({ number }) => used.has(number));
  console.log(`[ask] Answered from sources ${[...used].join(', ') || 'none'}`);
  return replyEmbed(COLORS.answer, header, overview, sources);
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({ content: '/ask only works in a server.', ...NO_PINGS });
    return;
  }
  const { member } = interaction;
  const asker = member.displayName;

  if (!tryAcquire(asker)) {
    await interaction.reply({
      content: `I'm still answering @${currentHolder() ?? 'someone'}'s question. Ask again when it's done.`,
      ...NO_PINGS,
    });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new AskTimeoutError()), TIMEOUT_MS);
  try {
    await interaction.deferReply();
    const rawQuestion = interaction.options.getString('question', true);
    // Replaced by the header with mentions as names once they're converted
    let header = askedHeader(asker, rawQuestion);

    let embed: EmbedBuilder;
    try {
      // The race makes the timeout end even a step that doesn't watch the signal (a stuck query).
      // The empty catch stops a timeout that fires after the race is over from going unhandled.
      const timedOut = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new AskTimeoutError()));
      });
      timedOut.catch(() => {});
      const work = async () => {
        const question = await mentionsToNames(rawQuestion, member);
        header = askedHeader(asker, question);
        console.log(`[ask] @${asker} asked: ${question}`);
        return answer(question, member, header, controller.signal);
      };
      embed = await Promise.race([work(), timedOut]);
    } catch (error) {
      console.error('[ask] Failed to answer:', error);
      const reason = controller.signal.aborted ? new AskTimeoutError() : error;
      embed = replyEmbed(COLORS.error, header, errorReason(reason));
    }
    await interaction.editReply({ embeds: [embed], ...NO_PINGS });
  } catch (error) {
    // Only Discord calls get here (the defer or the final edit), so there's nowhere to reply
    console.error('[ask] Could not reply:', error);
  } finally {
    clearTimeout(timer);
    release();
  }
}
