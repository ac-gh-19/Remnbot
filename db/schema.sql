-- Discord IDs are 64-bit snowflakes, so they fit in BIGINT

CREATE TABLE IF NOT EXISTS guilds (
  id          BIGINT PRIMARY KEY,
  name        TEXT NOT NULL,
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at     TIMESTAMPTZ                      -- set when the bot is removed from the server
);

CREATE TABLE IF NOT EXISTS channels (
  id          BIGINT PRIMARY KEY,
  guild_id    BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  parent_id   BIGINT REFERENCES channels(id),  -- set for threads
  name        TEXT NOT NULL,
  type        SMALLINT NOT NULL,               -- discord.js ChannelType
  last_backfilled_message_id BIGINT            -- lets a backfill resume where it stopped
);

CREATE TABLE IF NOT EXISTS messages (
  id          BIGINT PRIMARY KEY,
  channel_id  BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  guild_id    BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE, -- copied here so you can filter by server without a join
  author_id   BIGINT NOT NULL,
  author_name TEXT NOT NULL,                   -- name at the time of the message
  content     TEXT NOT NULL,                   -- raw text, including GIF/image links
  created_at  TIMESTAMPTZ NOT NULL,
  edited_at   TIMESTAMPTZ,
  deleted_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS messages_channel_id_id_idx ON messages (channel_id, id);
CREATE INDEX IF NOT EXISTS messages_guild_id_created_at_idx ON messages (guild_id, created_at);
