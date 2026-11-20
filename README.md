# Discord Memory Bot

A Discord bot that archives a server's chat history and lets you ask it about things you half
remember: "when did we plan the elden ring night?", "do you remember the fight that happened at
school?", "what was that restaurant @sam kept recommending?".

## Why

Discord's built-in search matches exact words. That works when you remember the exact words,
which is rarely the case for a memory: you remember roughly what happened, maybe who was there,
but not when it was, which channel it was in, or what anyone actually typed. A keyword search
for "fight" or "school" returns hundreds of unrelated messages.

This bot turns the history into something you can search by meaning. Every conversation is
summarized, both the summaries and short stretches of the raw messages are embedded, and a
question is matched against all of them at once. You can ask something general, and the bot
finds the conversations that fit, has Claude answer from them, and links straight to the
messages so you can read what was actually said.

## How it works

1. **`/backfill`** saves a channel's full message history to Postgres.
2. **`/chunk`** groups messages into conversations ("chunks"), split by silences of over an hour
   and capped at 150 messages, dropping bot posts and media-only messages.
3. **`/summarize`** has Claude summarize each conversation (topics, people, outcome), embeds
   the summaries with Voyage, and embeds overlapping 8-message windows of each conversation.
4. **`/ask <question>`** runs three searches, merges them, and has Claude answer from the top
   10 conversations, citing sources with links to the original messages. It only searches
   channels the asker can read.
5. **`/usage`** shows what `/ask` has cost the server this month and all time.

Each step resumes where it stopped and only does new work on a rerun, so after more chatting
you run `/backfill`, `/chunk`, `/summarize` again and only pay for the new conversations.

Mention a person as `@name` in a question to only search conversations they took part in.

See [architecture.md](architecture.md) for the full design and the specs in
[docs/specs](docs/specs) for individual features.

## Running it

### Requirements

- Node.js 22+
- PostgreSQL with the [pgvector](https://github.com/pgvector/pgvector) extension
  (Postgres.app includes it)
- A Discord application with a bot user, with the **Message Content**, **Server Members** and
  **Presence** intents enabled in the Developer Portal (login fails without them)
- A [Voyage AI](https://dashboard.voyageai.com) API key (embeddings)
- An [Anthropic](https://console.anthropic.com) API key (summaries and answers)

### Setup

```sh
npm install
cp .env.example .env          # fill in the values below
createdb discord_bot
psql "$DATABASE_URL" -f db/schema.sql   # safe to rerun
npm run deploy                # register the slash commands in GUILD_ID
npm run dev                   # run the bot with auto-restart
                              # or: npm run build && npm start
```

| Variable                                                                                        | Purpose                                                   |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `DISCORD_TOKEN`                                                                                 | The bot's token                                           |
| `CLIENT_ID`, `GUILD_ID`                                                                         | The application ID and the server to register commands in |
| `DATABASE_URL`                                                                                  | Postgres connection string (required)                     |
| `VOYAGE_API_KEY`                                                                                | Embeddings, needed by `/summarize` and every search       |
| `ANTHROPIC_API_KEY`                                                                             | Claude, needed by `/summarize` and `/ask`                 |
| `SUMMARY_MODEL`, `ANSWER_MODEL`                                                                 | `opus` (default), `sonnet` or `haiku`                     |
| `CHUNK_MESSAGE_LIMIT`, `CHUNK_OVERLAP`, `CONVERSATION_GAP_MINUTES`, `CONVERSATION_MIN_MESSAGES` | How messages are grouped into conversations               |

### Using it

In Discord, in each channel (or thread) you want searchable, run as someone with Manage Server:

```
/backfill
/chunk
/summarize
```

Then anyone can `/ask` a question. From the terminal, `npm run search "<question>"` prints the
ranked results without calling Claude, which is handy for checking search on its own.

### Other scripts

| Command                                               | What it does                                          |
| ----------------------------------------------------- | ----------------------------------------------------- |
| `npm run search "<question>"`                         | Search from the terminal, showing each result's ranks |
| `npm run eval [-- <label>]`                           | Score search quality (see below)                      |
| `npm run typecheck`, `npm run lint`, `npm run format` | Checks and formatting                                 |

## Choosing the search weights

### Three searches

Each question is searched three ways, because each catches what the others miss:

- **Summary search** compares the question with each conversation's summary embedding. Good for
  "what was it about" questions ("when did we argue about moving out?"), weak on specific lines
  since a summary leaves most of them out.
- **Window search** compares the question with embeddings of 8-message stretches of the raw
  chat. Good for "someone said something like..." questions, where the answer is one exchange
  inside a long conversation.
- **Keyword search** is Postgres full-text search over raw messages. Good for exact names and
  rare words, noisy for common ones (any message containing "take" matches "take").

The three return scores on different scales (two cosine similarities and a text rank), so they
are merged by rank with weighted **reciprocal rank fusion**: each search gives a conversation
`weight / (RRF_K + rank)` points, and the points are added up. A conversation found by several
searches beats one ranked slightly higher by just one. The open questions were the weight of
each search and `RRF_K`.

### The eval suite

`npm run eval` measures how often search finds the right conversation:

- **80 questions** in `eval-questions.json`, two written from each of **40 known
  conversations**, so each question's correct answer is known. One is **broad** (what the
  conversation was about, the way you'd remember it later) and one is **detail** (a specific
  thing someone said). The conversations span the summarizer's substance ratings (28 low,
  52 medium questions).
- Each question is searched once, then the same three ranked lists are merged under every
  weighting in `SETUPS` in `src/eval.ts`, so comparing setups costs no extra searches.
- Each setup is scored on **top 1** (answer ranked first), **top 10** (answer in the results
  `/ask` uses) and **MRR** (mean reciprocal rank: 1 for a #1, 0.5 for a #2, 0 outside the top
  10), overall and for broad and detail questions separately.
- Results are written to `eval-results/<date>[-label].json` with the commit they ran against.

Both files quote real messages, so they are gitignored and not part of the repo.

### Findings

Scores from the run of 2026-11-17 (80 questions, `RRF_K` = 5). Weights are summary / window /
keyword.

| Setup             | Weights          | Top 1   | Top 10  | MRR      | Broad top 1 | Broad MRR | Detail top 1 | Detail top 10 | Detail MRR |
| ----------------- | ---------------- | ------- | ------- | -------- | ----------- | --------- | ------------ | ------------- | ---------- |
| Summary only      | 1 / 0 / 0        | 60%     | 88%     | 0.68     | 78%         | 0.84      | 43%          | 78%           | 0.52       |
| Summary + keyword | 1 / 0 / 0.5      | 65%     | 93%     | 0.74     | 75%         | 0.83      | 55%          | 88%           | 0.65       |
| Windows 0.5       | 1 / 0.5 / 0.5    | 74%     | 95%     | 0.82     | 83%         | 0.89      | 65%          | 93%           | 0.75       |
| Windows 1         | 1 / 1 / 0.5      | 70%     | 96%     | 0.81     | 80%         | 0.88      | 60%          | 95%           | 0.74       |
| **Chosen**        | **1 / 1 / 0.25** | **73%** | **96%** | **0.81** | **88%**     | **0.92**  | 58%          | **95%**       | 0.71       |

What we learned:

1. **Summaries alone handle broad questions but miss details.** 98% of broad questions had
   their answer in the top 10, but only 78% of detail questions did, and only 43% at #1.
2. **Windows are the biggest single improvement.** Adding window search took overall top 1 from
   65% to 70–74% and detail top 10 from 88% to 93–95%, while also lifting broad questions.
   Matching the question against the actual lines is what finds the one exchange inside a long
   conversation.
3. **Keyword search trades broad accuracy for detail accuracy.** It helps detail questions,
   where an exact word often appears, but on broad questions it pulls in conversations that
   happen to share a common word. Lowering it from 0.5 to 0.25 raised broad top 1 from 80% to
   88% (3 more questions answered first) and cost 1 detail question at #1, without changing
   either top 10.
4. **A small `RRF_K` works better here.** The usual default of 60 flattens rank differences so
   much that a conversation ranked #9 and #34 by two searches beat one ranked #1 by a single
   search. With only 50 candidates per search the top of each list is what matters. 5 and 10
   scored about the same; 20 and 60 were clearly worse.

The chosen weights (summary 1, window 1, keyword 0.25, `RRF_K` 5) were the best of 114
configurations swept on broad questions, raising broad MRR from 0.88 (the earlier 1 / 0.5 / 0.5
with `RRF_K` 10) to 0.92. We optimized for broad questions because that is what the bot is for:
remembering roughly what happened and finding where it was. Detail questions still land in the
top 10 95% of the time, which is what matters for `/ask`, since Claude reads all 10 results
before answering.

Overall, compared with summary search alone, the chosen setup puts the right conversation first
for 73% of questions instead of 60%, and in the top 10 for 96% instead of 88%.

To try other weightings, add them to `SETUPS` in `src/eval.ts` and run
`npm run eval -- <label>`. The defaults live in `src/retrieval.ts`.

### Limits of this testing

All of the above was measured on **one server's history**, and the chunk and window sizes
weren't tuned at all: chunks are capped at 150 messages and split by an hour of silence, and
windows are 8 messages starting every 4 (`src/config.ts`, `src/windows.ts`). These are
reasonable starting points for our server, not settings proven to work everywhere.

The best sizes almost certainly depend on the server and how active it is:

- **A busy server** where messages come every few seconds and several topics overlap may need
  a shorter silence gap or a smaller chunk cap, so that one "conversation" isn't really three,
  each with a summary too vague to match. Its single exchanges also cover more messages, so
  larger windows may capture them better.
- **A quiet server** with a few messages an hour may need a longer silence gap, or a single
  conversation gets cut into pieces too small to summarize (and dropped under the minimum
  size). Smaller windows may suit its shorter exchanges.
- **Writing style matters too.** A group that sends many one-word messages needs more messages
  per window to carry the same meaning as one that writes paragraphs.

The search weights depend on these sizes as well: the windows and summaries being ranked change
whenever the chunking does, so weights tuned on one server's chunks may not be the best on
another's.

We didn't test this further because the answer varies so much from server to server and with
how active each one is. Doing it properly would need a question set for each kind of server,
and each change to chunking means summarizing and embedding everything again. If you run the
bot on a different server, it's worth writing a small question set from conversations you know,
then trying a few chunking settings (via `.env`) and window sizes with `npm run eval`.

## Status

The bot is private to one friend group's server; there is no hosted version or billing.
