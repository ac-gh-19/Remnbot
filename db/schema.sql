-- Discord IDs are 64-bit snowflakes, so they fit in BIGINT

CREATE EXTENSION IF NOT EXISTS vector;        -- pgvector: the vector type and nearest-neighbour search

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

-- Bots' messages are kept so the archive is complete, but left out of chunks. Messages saved
-- before this column existed need filling in once; see "Bot messages" in architecture.md.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS author_is_bot BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS messages_channel_id_id_idx ON messages (channel_id, id);
CREATE INDEX IF NOT EXISTS messages_guild_id_created_at_idx ON messages (guild_id, created_at);

-- Keyword search over raw message text (slang, names, inside jokes); kept up to date by Postgres
ALTER TABLE messages ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
CREATE INDEX IF NOT EXISTS messages_search_tsv_idx ON messages USING gin (search_tsv);

-- One row per conversation chunk. Chunks are rebuilt from messages on every backfill;
-- content_hash recognises a rebuilt chunk as one already stored, so its summary and
-- embedding are kept rather than paid for again.
CREATE TABLE IF NOT EXISTS chunks (
  id               BIGSERIAL PRIMARY KEY,
  channel_id       BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  guild_id         BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  first_message_id BIGINT NOT NULL,          -- the chunk's messages are this channel's
  last_message_id  BIGINT NOT NULL,          -- messages with IDs in this range
  started_at       TIMESTAMPTZ NOT NULL,
  ended_at         TIMESTAMPTZ NOT NULL,
  content_hash     TEXT NOT NULL,            -- sha256 of each message's ID and text
  summary          TEXT,                     -- NULL until the chunk is summarized
  topics           TEXT[],
  summary_attempts INT NOT NULL DEFAULT 0,   -- lets the summarizer give up on a chunk that keeps failing
  embedding        vector(1024),             -- NULL until the summary is embedded
  embedding_model  TEXT,                     -- e.g. 'voyage-4', to find rows a model change made stale
  search_tsv       tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(summary, ''))) STORED,
  UNIQUE (channel_id, content_hash)
);

-- The rest of the summarizer's output. Kept so the embedded text can be rebuilt (and re-embedded)
-- without summarizing again. Added with ALTER so re-running this file updates existing databases.
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS entities JSONB;     -- [{"name": "Elden Ring", "type": "game"}, ...]
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS substance TEXT
  CHECK (substance IN ('low', 'medium', 'high'));
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS outcome TEXT;       -- NULL when there was none, or before summarizing

CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS chunks_search_tsv_idx ON chunks USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS chunks_channel_id_first_message_id_idx ON chunks (channel_id, first_message_id);

-- Windows: about 8 consecutive messages of a summarized chunk, embedded as is, so a search can
-- find a conversation by an exact line its summary left out. Like chunks, a window stores its
-- message range rather than its text. Deleted along with their chunk when /chunk replaces it.
CREATE TABLE IF NOT EXISTS windows (
  id               BIGSERIAL PRIMARY KEY,
  chunk_id         BIGINT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  channel_id       BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  first_message_id BIGINT NOT NULL,
  last_message_id  BIGINT NOT NULL,
  embedding        vector(1024) NOT NULL,
  embedding_model  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS windows_embedding_idx ON windows USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS windows_chunk_id_idx ON windows (chunk_id);

-- Usage: one row per Claude call made for a server, so the API bill can be split between servers.
-- A row starts 'pending' just before the call and becomes 'done' or 'failed' (a refusal or a reply
-- in the wrong format, which still cost tokens) or 'interrupted' (a timeout, an error with no
-- response, or a crash: the bot marks leftover 'pending' rows at startup). No foreign key to
-- guilds, so the cost history outlives a server's other data.
CREATE TABLE IF NOT EXISTS usage (
  id                 BIGSERIAL PRIMARY KEY,
  guild_id           BIGINT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('ask')),
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'done', 'failed', 'interrupted')),
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at        TIMESTAMPTZ,
  model              TEXT,                   -- the model that answered (response.model), which a fallback can change
  input_tokens       INT,
  output_tokens      INT,
  cache_write_tokens INT,
  cache_read_tokens  INT,
  cost_micro_usd     BIGINT                  -- millionths of a dollar at the price when written; NULL if unknown
);

CREATE INDEX IF NOT EXISTS usage_guild_id_started_at_idx ON usage (guild_id, started_at);
