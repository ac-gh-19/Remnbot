import pg from 'pg';
import type { Guild, GuildTextBasedChannel, Message } from 'discord.js';
import { databaseUrl } from './config.js';

// Shared by every command; BIGINT columns come back as strings, matching discord.js IDs
export const pool = new pg.Pool({ connectionString: databaseUrl });

export async function upsertGuild(guild: Guild): Promise<void> {
  await pool.query(
    `INSERT INTO guilds (id, name) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, left_at = NULL`,
    [guild.id, guild.name],
  );
}

async function upsertChannelRow(
  channel: { id: string; guildId: string; name: string; type: number },
  parentId: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO channels (id, guild_id, parent_id, name, type) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, parent_id = EXCLUDED.parent_id`,
    [channel.id, channel.guildId, parentId, channel.name, channel.type],
  );
}

// A thread's parent channel is saved first, since channels.parent_id must point at a saved row
export async function upsertChannel(channel: GuildTextBasedChannel): Promise<void> {
  const parent = channel.isThread() ? channel.parent : null;
  if (parent) await upsertChannelRow(parent, null);
  await upsertChannelRow(channel, parent?.id ?? null);
}

// Where the last backfill of this channel stopped, or null if it was never backfilled
export async function getBackfillCursor(channelId: string): Promise<string | null> {
  const { rows } = await pool.query<{ cursor: string | null }>(
    'SELECT last_backfilled_message_id AS cursor FROM channels WHERE id = $1',
    [channelId],
  );
  return rows[0]?.cursor ?? null;
}

// Saves a page of messages (oldest first) and moves the channel's backfill cursor to the
// newest one in a single statement, so the cursor never gets ahead of what was saved.
// Messages already in the table are left as they are. Returns how many were new.
export async function saveMessages(channelId: string, messages: Message[]): Promise<number> {
  const last = messages.at(-1);
  if (!last) return 0;

  const { rows } = await pool.query<{ inserted: number }>(
    `WITH inserted AS (
       INSERT INTO messages (id, channel_id, guild_id, author_id, author_name, content, created_at, edited_at)
       SELECT * FROM unnest(
         $1::bigint[], $2::bigint[], $3::bigint[], $4::bigint[],
         $5::text[], $6::text[], $7::timestamptz[], $8::timestamptz[]
       )
       ON CONFLICT (id) DO NOTHING
       RETURNING 1
     ), moved_cursor AS (
       UPDATE channels SET last_backfilled_message_id = $9 WHERE id = $10
     )
     SELECT count(*)::int AS inserted FROM inserted`,
    [
      messages.map((m) => m.id),
      messages.map((m) => m.channelId),
      messages.map((m) => m.guildId),
      messages.map((m) => m.author.id),
      messages.map((m) => m.author.tag),
      messages.map((m) => m.content),
      messages.map((m) => m.createdAt.toISOString()),
      messages.map((m) => m.editedAt?.toISOString() ?? null),
      last.id,
      channelId,
    ],
  );
  return rows[0]?.inserted ?? 0;
}

// Each author's most recent name in a guild, for turning <@id> mentions back into names.
// People who were mentioned but never posted aren't included.
export async function authorNames(guildId: string): Promise<Map<string, string>> {
  const { rows } = await pool.query<{ id: string; name: string }>(
    `SELECT DISTINCT ON (author_id) author_id AS id, author_name AS name
     FROM messages
     WHERE guild_id = $1
     ORDER BY author_id, id DESC`,
    [guildId],
  );
  return new Map(rows.map(({ id, name }) => [id, name]));
}

export interface StoredMessage {
  id: string;
  authorName: string;
  content: string;
  createdAt: Date;
}

// Walks a channel's saved messages oldest-first, a page at a time so large channels
// aren't loaded into memory all at once
export async function* storedMessages(
  channelId: string,
  pageSize = 1000,
): AsyncGenerator<StoredMessage> {
  let after = '0';
  while (true) {
    const { rows } = await pool.query<StoredMessage>(
      `SELECT id, author_name AS "authorName", content, created_at AS "createdAt"
       FROM messages
       WHERE channel_id = $1 AND id > $2 AND deleted_at IS NULL
       ORDER BY id
       LIMIT $3`,
      [channelId, after, pageSize],
    );
    yield* rows;

    const last = rows.at(-1);
    if (!last || rows.length < pageSize) return;
    after = last.id;
  }
}
