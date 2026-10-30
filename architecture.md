# Architecture

A Discord bot written in TypeScript on top of [discord.js](https://discord.js.org) v14. It
has three slash commands: `/backfill` saves a channel's full message history to Postgres,
`/chunk` splits a channel's saved messages into conversation "chunks" in the `chunks` table,
and `/summarize` summarizes and embeds those chunks.

```
src/
  index.ts              Bot process: logs in, listens for interactions, dispatches commands
  deploy-commands.ts    One-off script: registers slash commands with Discord
  commands/
    index.ts            Command registry (Map of name -> command module)
    backfill.ts         /backfill
    chunk.ts            /chunk
    summarize.ts        /summarize
  services/
    summarizer.ts       Summarizes a chunk's transcript with Claude
    summaryEmbedder.ts  Formats a summary for embedding and embeds it
  config.ts             Env-driven settings (DATABASE_URL, chunking options)
  db.ts                 Postgres pool and queries
  chunker.ts            ConversationChunker (groups messages into chunks), textContent filter
  embedding.ts          Formats chunks as transcripts for summarizing; embeds text with Voyage
db/schema.sql           Tables: guilds, channels, messages, chunks
```

## Configuration

Everything comes from environment variables, loaded from `.env` by `dotenv/config` (see
`.env.example`):

| Variable | Used by | Purpose |
| --- | --- | --- |
| `DISCORD_TOKEN` | `index.ts`, `deploy-commands.ts` | The bot's secret token; authenticates both the gateway connection and REST calls |
| `CLIENT_ID` | `deploy-commands.ts` | The application ID that owns the commands |
| `GUILD_ID` | `deploy-commands.ts` | The server the commands are registered in |
| `DATABASE_URL` | `config.ts` → `db.ts` | Postgres connection string (required; startup throws without it) |
| `VOYAGE_API_KEY` | `config.ts` → `embedding.ts` | Voyage AI key for embeddings (optional; only needed to embed) |
| `CHUNK_MESSAGE_LIMIT`, `CHUNK_OVERLAP`, `CONVERSATION_GAP_MINUTES`, `CONVERSATION_MIN_MESSAGES` | `config.ts` → `chunker.ts` | Chunking behaviour, described under [Conversation chunking](#conversation-chunking-chunk) |

## How the bot connects to Discord

There are two separate channels of communication with Discord, and both are authenticated
with `DISCORD_TOKEN`:

1. **The Gateway (WebSocket)** — a long-lived connection over which Discord *pushes* events
   to the bot (messages, member updates, slash-command invocations, ...). This is what
   `src/index.ts` opens.
2. **The REST API (HTTPS)** — normal request/response calls the bot makes to *do* things or
   *fetch* things (reply to an interaction, fetch message history, register commands).
   discord.js handles this behind methods like `interaction.reply()` and
   `channel.messages.fetch()`; `deploy-commands.ts` uses the `REST` client directly.

### Startup (`src/index.ts`)

1. A `Client` is constructed with a list of **gateway intents** and **partials**.
   - *Intents* tell Discord which categories of events to send over the gateway. The bot
     currently requests nearly all of them. `MessageContent`, `GuildMembers` and
     `GuildPresences` are *privileged* intents and must also be switched on for the
     application in the Discord Developer Portal, or login fails.
   - *Partials* let discord.js emit events for objects it doesn't have fully cached (e.g. a
     reaction on an old message) instead of silently dropping them.
2. `client.login(DISCORD_TOKEN)` sets the token on the REST client, asks Discord for the
   gateway URL, opens the WebSocket and identifies with the token and intents. Discord
   replies with the bot's user and the guilds it's in, and discord.js populates its caches.
3. When that handshake finishes, `Events.ClientReady` fires once and logs
   `Logged in as <bot tag>`.
4. From then on discord.js keeps the connection alive (heartbeats, automatic reconnect and
   resume). Connection-level problems surface through `Events.Error`, which is logged.

The token identifies the *bot user*, not a person. Anyone holding it can act as the bot, so it
lives only in `.env` (gitignored).

### Handling a command

When a user runs a slash command, Discord sends an `INTERACTION_CREATE` event over the gateway,
which discord.js emits as `Events.InteractionCreate`:

1. Anything that isn't a chat-input (slash) command — buttons, autocomplete, etc. — is ignored.
2. The command module is looked up by name in the `commands` map from `src/commands/index.ts`.
3. Its `execute(interaction)` is awaited.
4. If it throws, the error is logged and the user gets "Something went wrong running that
   command." — via `editReply` if the command already deferred/replied, otherwise as a new
   ephemeral reply.

Discord requires every interaction to be acknowledged within **3 seconds**, and the
interaction token used for follow-ups is valid for 15 minutes. Long commands therefore call
`interaction.deferReply()` first (shows "Bot is thinking…") and `editReply()` when done.

## Commands

### Defining a command

Each command is a module in `src/commands/` exporting two things, matching the `Command`
interface in `src/commands/index.ts`:

- `data` — a `SlashCommandBuilder` describing the command (name, description, options,
  default permissions). `data.toJSON()` is the payload Discord stores.
- `execute(interaction)` — the handler run by `index.ts`.

`src/commands/index.ts` imports every command module and builds
`commands: Map<string, Command>` keyed by `data.name`. Both the bot process and the deploy
script read this one map, so it's the single source of truth for what commands exist.

### Registering commands with Discord (`npm run deploy`)

Slash commands are not discovered from the running bot. Discord has to be told about them
ahead of time, and it then shows them in the client's `/` menu and sends interactions for
them. That is `src/deploy-commands.ts`:

1. Reads `DISCORD_TOKEN`, `CLIENT_ID` and `GUILD_ID`.
2. Serialises every command's `data` with `toJSON()`.
3. Sends `PUT /applications/{CLIENT_ID}/guilds/{GUILD_ID}/commands` with that array via
   `rest.put(Routes.applicationGuildCommands(...))`.

A `PUT` **replaces** the guild's whole command set: new commands are created, changed ones
updated, and any command missing from the array is deleted.

Commands are registered per guild rather than globally because guild commands update
instantly, while global ones can take a while to propagate. As a result they only exist in
the `GUILD_ID` server.

The deploy script runs on its own; it doesn't open a gateway connection and the bot doesn't
need to be running.

### Adding a new command

1. Create `src/commands/<name>.ts` exporting `data` and `execute`.
2. Add it to the array in `src/commands/index.ts`.
3. Run `npm run deploy` so Discord knows about it (needed again whenever `data` changes: name,
   description, options or permissions; changes inside `execute` only need a bot restart).
4. Restart the bot (`npm run dev` restarts automatically on file changes).

## The `/backfill` command

`src/commands/backfill.ts`. Defaults to members with **Manage Server** permission
(`setDefaultMemberPermissions(ManageGuild)`; server admins can change this under
Integrations). Run it in a server text channel or thread to archive that channel's history.

### Flow

```
/backfill
  │
  ├─ guard: must be in a cached guild with a readable channel (else ephemeral error)
  ├─ deferReply (ephemeral)                       ← beats the 3-second deadline
  ├─ upsertGuild, upsertChannel                   ← ensure FK rows exist (thread's parent first)
  ├─ getBackfillCursor(channel)                   ← last saved message ID, or null
  │
  ├─ fetchAllMessages(channel, cursor ?? '0')     ← Discord → Postgres
  │    loop: GET 100 messages after `after`
  │          sort oldest-first → saveMessages() → after = newest ID
  │          stop when a page has < 100 messages
  │
  └─ editReply: "saved N new of M fetched messages …"
```

### Fetching history into Postgres

- **Paging.** Discord returns at most 100 messages per request. `fetchAllMessages` pages
  *forward* with the `after` parameter, starting from snowflake `'0'` (the beginning of time)
  or from the saved cursor. Each page arrives newest-first, so it's sorted by ID (snowflakes
  increase over time) before use. `cache: false` keeps discord.js from holding the whole
  history in memory. Rate limits are handled by discord.js's REST client, which queues and
  waits as needed.
- **Saving.** `saveMessages` (in `db.ts`) bulk-inserts a page with `unnest(...)` and
  `ON CONFLICT (id) DO NOTHING`, and in the *same statement* moves
  `channels.last_backfilled_message_id` to the page's newest ID. Because it's one statement,
  the cursor can never point past messages that weren't saved; if the bot crashes mid-run,
  the next run resumes cleanly. It returns how many rows were actually new.
- **Resuming.** Running `/backfill` again only fetches messages newer than the cursor.
  Edits and deletions of already-saved messages are not picked up (`edited_at` and
  `deleted_at` exist in the schema, but nothing updates them yet).

What gets stored per message: ID, channel, guild, author ID, author tag (as it was at the
time), raw content, created/edited timestamps. Attachments, embeds and reactions are not
stored.

## Conversation chunking (`/chunk`)

`src/commands/chunk.ts`, Manage Server by default like `/backfill`. Run it in a channel after
`/backfill`; like `/backfill`, it covers only that channel or thread. It rebuilds the channel's
chunks from **all** its saved messages and syncs them into the `chunks` table.
`storedMessages` (in `db.ts`) reads a channel from Postgres 1000 rows at a time, oldest-first,
skipping rows with `deleted_at` set.

Messages from bots (`author_is_bot`) are skipped too: level-ups, music queues, Wordle results
and the like aren't conversation. They're still saved by `/backfill`, so the archive stays
complete. Messages saved before `author_is_bot` existed default to `false`, and `/backfill` only
fetches new messages, so a database from before then needs a one-time fill. Bots' tags still
carry a `#1234` discriminator while migrated users' don't, which finds them:

```sql
UPDATE messages SET author_is_bot = true WHERE author_name LIKE '%#%';
```

Check the matched names first (`SELECT DISTINCT author_name ...`): a user who never migrated to
the new username system also has one. Re-run `/chunk` afterwards; chunks that held bot
messages get new hashes and are replaced.

`textContent` removes Tenor/Giphy/Klipy links and direct links to image/video files. Messages
with nothing left (GIF-only, image-only, attachment-only) aren't worth chunking.

`ConversationChunker` groups the remaining messages by conversation:

- **Gap split** — if more than `CONVERSATION_GAP_MINUTES` pass between two messages, the
  current conversation ends and the next message starts a fresh chunk.
- **Minimum size** — a conversation with fewer than `CONVERSATION_MIN_MESSAGES` messages is
  dropped (e.g. a lone "gm"), unless it already had to be split across chunks.
- **Size split with overlap** — a chunk that reaches `CHUNK_MESSAGE_LIMIT` is closed, and the
  next one starts with the previous chunk's last `CHUNK_OVERLAP` messages, so an exchange that
  straddles the split appears whole in at least one chunk. Each chunk's `overlap` field says
  how many of its leading messages were carried over.

Only each chunk's metadata is kept in memory: first/last message ID, start/end time, and a
`content_hash` (sha256 of each message's ID and filtered text). `replaceChunks` then syncs the
channel in a single statement: chunks whose hash is already stored are left alone (keeping any
summary and embedding), new hashes are inserted, and stored chunks that are no longer produced
are deleted. Because it's one statement, a failure leaves the table as it was, and re-running
is always safe. Usually only the newest conversation changes between runs.

Changing any chunking setting changes most hashes, so every chunk gets replaced (and would
need summarizing again).

## Summarizing and embedding (`/summarize`)

`src/commands/summarize.ts`, Manage Server by default. Run it in a channel after `/chunk`.
`pendingChunks` (in `db.ts`) walks the channel's chunks oldest-first, a page at a time, picking
those not yet embedded with the current `EMBEDDING_MODEL` and skipping any whose summary has
failed 3 times (`summary_attempts`).

They're processed 8 at a time:

1. Chunks without a summary have their messages loaded (`messagesBetween`), filtered with
   `textContent` as `/chunk` did, and are summarized concurrently. Each summary is saved as
   soon as it arrives; a failure is logged and bumps `summary_attempts`, and the rest carry on.
2. Every chunk in the batch that now has a summary is embedded in one Voyage request
   (`embedSummaries`), and the vectors and model name are saved together.

Because summaries are saved before embedding, an embedding failure stops the run without
losing them: the next run re-embeds from the stored summary fields without summarizing again.
Changing `EMBEDDING_MODEL` makes every chunk pending again, but only for re-embedding.

A large channel can take longer than the 15 minutes an interaction token lasts; the result is
always logged, and a reply that can no longer be sent is only logged as a warning.

## Database

`db/schema.sql` defines four tables. Discord IDs are 64-bit snowflakes stored as `BIGINT`;
`pg` returns them as strings, which matches how discord.js represents IDs. It needs the
[pgvector](https://github.com/pgvector/pgvector) extension (bundled with Postgres.app).

- `guilds` — servers the bot has backfilled in (`left_at` is reserved for when the bot is removed).
- `channels` — channels and threads (`parent_id` links a thread to its channel) plus the
  backfill cursor `last_backfilled_message_id`.
- `messages` — one row per message, indexed on `(channel_id, id)` for ordered per-channel
  reads and `(guild_id, created_at)` for per-server time queries. `search_tsv` is a
  generated full-text column for keyword search over the raw text.
- `chunks` — conversation chunks, each covering the channel's messages from
  `first_message_id` to `last_message_id`. `content_hash` (sha256 of each message's ID and
  text) identifies a chunk across rebuilds, so an unchanged chunk keeps its `summary` and
  `embedding` (a pgvector `vector(1024)`). Both start as NULL, which is how pending work is
  found. Alongside the summary are the rest of the summarizer's output: `topics`, `entities`
  (JSONB), `substance` (`low`/`medium`/`high`) and `outcome`, kept so the embedded text can
  be rebuilt without summarizing again. `search_tsv` indexes the summary for keyword search.

The schema isn't applied automatically; create the database and run it once:

```sh
createdb discord_bot
psql "$DATABASE_URL" -f db/schema.sql
```

All statements use `IF NOT EXISTS`, so re-running it is safe.

## Running it

```sh
npm install
cp .env.example .env     # fill in token, IDs, DATABASE_URL
psql "$DATABASE_URL" -f db/schema.sql
npm run deploy           # register slash commands in GUILD_ID
npm run dev              # run the bot with auto-restart (or: npm run build && npm start)
```
