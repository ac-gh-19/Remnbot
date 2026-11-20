# Architecture

A Discord bot (TypeScript, [discord.js](https://discord.js.org) v14) that archives a friend
group's chat history and makes it searchable by question: "when did we plan the elden ring
night?", "do you remember the fight that happened at school?".

## How it works

From an empty database to an answered question:

1. **`/backfill`** saves a channel's history to Postgres. → `messages`
2. **`/chunk`** drops bot and media-only messages and groups the rest into conversations
   ("chunks"). → `chunks`, each a range of message IDs
3. **`/summarize`** has Claude summarize each new chunk, Voyage embed the summaries, then cuts
   chunks into overlapping 8-message windows and embeds those. → `chunks.embedding`, `windows`
4. **`/ask`** (or `npm run search`) runs three searches (summaries, windows, keywords), merges
   them by rank, and has Claude answer from the top results. → a public embed, a `usage` row
5. **`/usage`** adds up what `/ask` has cost the server.

`npm run eval` reruns the search over a fixed question set to score its quality.

## The parts, by layer

*Discord plumbing*: connects to Discord and routes slash commands.
- `index.ts`: the bot process. Logs in and sends each slash command to its module.
- `deploy-commands.ts`: one-off script that registers the commands with Discord.
- `commands/index.ts`: the command registry (name → module), read by both of the above.

*Commands* (`commands/`): `backfill`, `chunk`, `summarize`, `ask`, `usage`. `askLock.ts` is the
in-memory lock that allows one question at a time.

*Text and model calls*: turns messages into text and calls Claude or Voyage; no SQL here.
- `chunker.ts`: `ConversationChunker` (the grouping rules) and `textContent` (the media filter).
- `embedding.ts`: transcript formatting and `embed`, the Voyage client with retries.
- `windows.ts`: the windowing rule and `buildWindows`.
- `services/summarizer.ts`, `services/summaryEmbedder.ts`: the summarizing call and the text
  that represents a summary when embedded.
- `services/answerContext.ts`, `services/answerer.ts`: the `[source N]` context and the `/ask`
  Claude call.

*Storage*: so command code never builds SQL.
- `db.ts`: the Postgres pool and every query except search's own.
- `usage.ts`: writing and summing `usage` rows.
- `db/schema.sql`: the six tables (see [Database](#database)).

*Search*: kept apart from terminal output so the eval runs exactly what search runs.
- `retrieval.ts`: parsing, the three searches (`searchLists`), fusion (`fuse`), the weights,
  and loading a chunk's messages (`chunkMessages`).
- `search.ts`: the `npm run search` command line. `eval.ts`: the `npm run eval` scorer.

*Settings*: `config.ts` reads `.env`.

## Key decisions

1. **Rebuild chunks, keep the paid-for work.** `/chunk` regroups every message on each run, and
   a content hash recognises unchanged chunks so their summaries and embeddings survive.
2. **Store message ranges, not text.** Chunks and windows point at message IDs, so what's shown
   always matches the archive. The cost is reloading messages to display them.
3. **Three searches merged by rank.** Summaries match what a conversation was about, windows the
   specific lines, keywords exact words. Their scores aren't comparable, so only ranks are
   merged. The weights were picked with `npm run eval`.
4. **One process, one question at a time.** `/ask` holds an in-memory lock, and on startup any
   `usage` row still `pending` is marked `interrupted`, since nothing can be in flight.

## Terms

- **Chunk**: one conversation, up to 150 messages, ended by a silence of over an hour.
- **Window**: 8 consecutive messages of a chunk; a new one starts every 4 messages.
- **Embedding**: a vector from Voyage in which similar meanings land close together.
- **RRF**: reciprocal rank fusion; each list gives a result weight ÷ (`RRF_K` + rank) points.
- **Substance**: the summarizer's low/medium/high rating of how much a conversation contains.

## Configuration

From `.env`, loaded by `dotenv/config` (see `.env.example`):

| Variable | Purpose |
| --- | --- |
| `DISCORD_TOKEN` | The bot's secret token (bot process and deploy script) |
| `CLIENT_ID`, `GUILD_ID` | The application and the server commands are registered in |
| `DATABASE_URL` | Postgres connection string (required) |
| `VOYAGE_API_KEY` | Embeddings; needed to summarize and search |
| `ANTHROPIC_API_KEY` | Claude; needed by `/summarize` and `/ask` |
| `SUMMARY_MODEL`, `ANSWER_MODEL` | `opus` (default), `sonnet` or `haiku` |
| `CHUNK_MESSAGE_LIMIT`, `CHUNK_OVERLAP`, `CONVERSATION_GAP_MINUTES`, `CONVERSATION_MIN_MESSAGES` | Chunking rules (see [`/chunk`](#chunk)) |

## Connecting and registering

**The bot** (`index.ts`) logs in over the gateway with `MessageContent`, `GuildMembers` and
`GuildPresences` among its intents; those three are privileged and must be enabled in the
Developer Portal or login fails. Each slash command is looked up in the registry and its
`execute` awaited; if it throws, the user gets "Something went wrong running that command."
Discord needs a reply within 3 seconds, so long commands `deferReply()` first, then
`editReply()` within the 15 minutes the interaction token lasts.

**Registering** (`npm run deploy`): each command module exports `data` (a
`SlashCommandBuilder`) and `execute`. The deploy script `PUT`s every command's `data` to
`GUILD_ID`, which replaces the server's whole command set. Guild commands update instantly but
exist only in that server.

**Adding a command**: create `src/commands/<name>.ts`, add it to `src/commands/index.ts`, run
`npm run deploy` (again whenever `data` changes), restart the bot.

## Commands

All except `/ask` default to members with **Manage Server**, and each pipeline command covers
only the channel or thread it's run in.

### `/backfill`

Pages forward through the channel's history 100 messages at a time from the saved cursor (or
the beginning), oldest-first. `saveMessages` inserts a page and moves
`channels.last_backfilled_message_id` in one statement, so a crash never leaves the cursor past
unsaved messages, and a rerun only fetches newer messages. Edits, deletions, attachments,
embeds and reactions aren't captured.

### `/chunk`

Rebuilds the channel's chunks from all its saved messages, skipping bot messages and those
`textContent` leaves empty (GIF, image or attachment only). `ConversationChunker`:

- **Gap split**: a silence over `CONVERSATION_GAP_MINUTES` starts a new chunk.
- **Minimum size**: a conversation under `CONVERSATION_MIN_MESSAGES` is dropped (e.g. a lone
  "gm"), unless it was already split.
- **Size split**: a chunk at `CHUNK_MESSAGE_LIMIT` closes, and the next starts with its last
  `CHUNK_OVERLAP` messages so an exchange across the split appears whole once.

`replaceChunks` syncs in one statement: known hashes are kept, new ones inserted, missing ones
deleted. Changing a chunking setting changes most hashes, so everything needs summarizing again.

### `/summarize`

Takes chunks not yet embedded with the current `EMBEDDING_MODEL`, 8 at a time, skipping any
whose summary failed 3 times. Summaries are saved as they arrive, then the batch is embedded in
one Voyage request, so an embedding failure never loses a summary. A second pass cuts each
summarized chunk without windows into 8-message windows and embeds them in requests of up to
500. Every step resumes where it stopped on the next run.

### `/ask`

Full design: [`docs/specs/ask-command.md`](docs/specs/ask-command.md).

1. Takes the lock; anyone asking meanwhile is told whose question is in progress. A 3-minute
   timeout aborts the Claude call.
2. Searches only channels where the asker has View Channel and Read Message History (see
   [Searching](#searching)).
3. Builds the context: the top 3 results in full, 4–10 as summary + best window + best keyword
   match, each labelled `[source N]`.
4. Claude (no tools) returns `{ overview, sourcesUsed, answerable }`.
5. Posts publicly, pinging nobody: "@asker asked:", the question, the overview and links to the
   sources used. No results means no Claude call.

### `/usage`

Full design: [`docs/specs/usage-tracking.md`](docs/specs/usage-tracking.md).

Each `/ask` Claude call writes a `usage` row: `pending` before the call, then `done`, `failed`
(refusal or bad format, still costs tokens) or `interrupted` (timeout, crash), with the cost
from `modelPrices` in `config.ts`. `/usage` shows this server's cost and question count for the
month and all time, visible only to whoever ran it. Usage writes never break `/ask`; only
`/ask` is tracked.

## Searching

`retrieval.ts`, used by `/ask`, `npm run search` and `npm run eval`:

1. `parseQuestion` resolves `@name` to authors and builds the text to embed, the text for
   keyword search and an author filter.
2. `searchLists` embeds the question once and runs three searches, filtered by author and
   channel:
   - **summary**: the 50 nearest summary embeddings;
   - **window**: the 150 nearest windows, each chunk kept at its best, up to 50;
   - **keyword**: full-text search over raw messages, a chunk ranked by its best message.
3. `fuse` merges the lists with weighted RRF and keeps the top 10.

`npm run eval` scores this against `eval-questions.json` (80 questions written from 40 known
conversations) under every setup in `SETUPS`, reporting hit@1, hit@10 and MRR, and writes
`eval-results/<date>[-label].json`. Both files quote real messages and are gitignored.

## Database

`db/schema.sql`, which needs [pgvector](https://github.com/pgvector/pgvector). Discord IDs are
`BIGINT`, returned by `pg` as strings like discord.js uses.

- `guilds`: servers the bot has backfilled in.
- `channels`: channels and threads (`parent_id` for a thread) plus the backfill cursor.
- `messages`: one row per message, with a generated `search_tsv` for keyword search.
- `chunks`: a range of a channel's messages, its `content_hash`, and the summarizer's output
  (`summary`, `topics`, `entities`, `substance`, `outcome`) and `embedding`. NULL summary or
  embedding marks pending work.
- `windows`: a message range within a chunk and its `embedding`. Deleted with its chunk.
- `usage`: one row per `/ask` Claude call: status, model, token counts and `cost_micro_usd`.
  No foreign key to `guilds`, so cost history outlives a server's data.

It isn't applied automatically; every statement uses `IF NOT EXISTS`, so rerunning is safe.

## Running it

```sh
npm install
cp .env.example .env     # fill in token, IDs, DATABASE_URL, API keys
createdb discord_bot
psql "$DATABASE_URL" -f db/schema.sql
npm run deploy           # register slash commands in GUILD_ID
npm run dev              # run the bot with auto-restart (or: npm run build && npm start)
# in Discord, per channel: /backfill, then /chunk, then /summarize
npm run search "when did we plan the elden ring night?"
npm run eval -- <label>  # score search after changing weights
```
