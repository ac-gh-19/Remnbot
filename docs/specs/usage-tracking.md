# Usage tracking: what each server's /ask questions cost

## Goal

Record what every `/ask` Claude call costs, per server, so the API bill can be split between
servers. A new `/usage` command shows a server its own totals. If the bot crashes during a
call, the record survives as "interrupted" rather than vanishing.

There is no billing: nothing is charged and nothing is blocked. This only measures.

Flow for one `/ask`:
1. `commands/ask.ts`: runs the search as today. If nothing is found, Claude isn't called and
   nothing is recorded.
2. `usage.ts` (new): inserts a usage row for the server with status `pending`, just before
   the Claude call.
3. `services/answerer.ts`: calls Claude and now also returns the response's token counts and
   the model that answered.
4. `usage.ts`: updates the row to `done` (or `failed`) with the tokens and the cost, or to
   `interrupted` if the call timed out.
5. `index.ts`: on startup, any row still `pending` is marked `interrupted`. The bot is one
   process, so nothing can be in flight right after a restart.
6. `commands/usage.ts` (new): `/usage` adds up the server's rows.

## Decisions

1. **A new `usage` table, one row per Claude call.** Totals are added up when `/usage` asks,
   not kept as counters on `guilds`. *Why:* a call needs a `pending` state before it finishes,
   which a running total can't have; rows also give per-month totals for free.
2. **Crash handling: pending → done, with a sweep at startup.** A row left `pending` by a
   crash becomes `interrupted` with no tokens and no cost, and `/usage` lists the count
   separately as "cost unknown". No estimate is made. *Why:* after a crash there is no way to
   tell from the bot's side whether the request reached Anthropic or what it cost; the
   Anthropic Console is the place to check if a total ever looks wrong. Crashes in that window
   should be rare.
3. **What a row stores:** server ID, status, start and finish times, the model that actually
   answered (`response.model`, which differs from the requested one when a fallback model took
   over), the four token counts (input, output, cache write, cache read), and the cost in
   micro-dollars (millionths of a dollar, a whole number) computed when the row is written.
   *Why:* prices change over time, so the cost is fixed at the price that applied when the call
   was made; the token counts are kept so it can be recomputed.
4. **Prices live in `config.ts`,** in a price table keyed by model ID: dollars per million
   tokens for input, output, cache write and cache read. It covers the three models in
   `claudeModels` plus the models server-side fallback can switch to. A model missing from the
   table still gets a row with its tokens, but with no cost (`NULL`), and a warning is
   logged. `/usage` counts such rows as "cost unknown" too.
5. **Only `/ask`'s Claude call is tracked.** The Voyage embedding of the question (a fraction
   of a cent) and `/summarize` are not. `/summarize` can be added later as its own spec step;
   the table has a `kind` column (`'ask'` for now) so those rows can share it.
6. **Failed calls:** a refusal or a reply that doesn't fit the expected format still comes
   back with token counts, so it is recorded as `failed` with its cost and counted in the
   totals. A timeout or other error with no response is recorded as `interrupted`, like a
   crash.
7. **`/usage`:** needs the Manage Server permission, and the reply is visible only to the
   person who ran it. It shows this server's cost and question count for this month and for
   all time, plus the number of interrupted questions (only when there are any). Months are
   calendar months in UTC.
8. **Usage rows outlive the server's other data.** The `usage` table has no foreign key to
   `guilds`, so nothing deletes usage rows along with a server's row, and a server's row can
   still be deleted without first deleting its usage. *Why:* the cost history is kept for
   settling up even after the bot leaves a server.
9. **Tests are manual,** as for `/ask`: the repo has no test runner.

## Acceptance criteria

1. Running `db/schema.sql` on an existing database adds the `usage` table without touching the
   other tables, and running it twice is harmless.
2. A successful `/ask` leaves one `done` row for that server, with nonzero input and output
   tokens, the answering model, and a cost that matches the price table to the micro-dollar
   (check one row by hand).
3. A `/ask` with no search results leaves no row.
4. A `/ask` that hits the 3-minute timeout leaves one `interrupted` row, not `pending`.
5. Killing the bot (Ctrl+C) while `/ask` is waiting on Claude, then restarting it, turns that
   row from `pending` into `interrupted`.
6. `/usage` is visible only to its user, is hidden from members without Manage Server, and
   shows this month's and all-time cost (in dollars, to the cent) and question counts that
   match the rows for that server only. The interrupted count appears only when it's above 0.
7. In a second server, `/usage` shows only that server's questions.
8. `/ask` behaves exactly as before for the asker: same replies and same timings, and a
   failure to write a usage row is logged but doesn't stop the answer.
9. `npm run build` and `npm run lint` pass.

## Implementation steps

1. **Schema and prices:** add the `usage` table (with an index on server ID and start time) to
   `db/schema.sql`; add the price table to `config.ts`, checked against Anthropic's pricing
   page, including the models server-side fallback can switch to.
2. **Usage module (`src/usage.ts`):** start a row, finish it (done or failed, with tokens and
   cost), mark it interrupted, sweep `pending` rows at startup, add up a server's totals, and
   compute a cost from token counts and a model ID.
3. **Answerer returns usage:** `answerQuestion` returns the token counts and the answering
   model along with the answer, and `AnswerError` carries them on a refusal or a reply in the
   wrong format.
4. **Wire into `/ask` and startup:** start the row just before the Claude call; finish or
   interrupt it on every path; make any error from writing a usage row log only; run the sweep
   in `index.ts` before the bot logs in.
5. **`/usage` command:** the command, its embed, and registration in `commands/index.ts`.
6. **Check and document:** deploy, run through the acceptance criteria in Discord, and add the
   `usage` table and `/usage` to `architecture.md`.
