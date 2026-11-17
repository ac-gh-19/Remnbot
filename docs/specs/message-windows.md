# Message windows: embed raw messages alongside summaries

## Goal

Questions about specific details ("did ac ever hit 225 bench") miss because each conversation
(up to 150 messages) is embedded only as a 2–5 sentence summary, and specifics are the first
thing a summary drops. Add **windows**: about 8 consecutive raw messages, embedded as is, each
linked to its parent conversation. Search them as a third ranked list next to the summary and
keyword searches, so a conversation can be found by an exact line even when its summary leaves
it out.

Flow after this change:
1. `/chunk`: groups messages into conversations (unchanged).
2. `/summarize`: summarizes and embeds each conversation (unchanged), then cuts each
   conversation into windows and embeds them (new pass).
3. `search`: runs the summary, window and keyword searches, collapses window hits to their
   parent conversations, merges the three ranked lists with reciprocal rank fusion (RRF),
   and prints each result with its best window.

## Decisions

1. **Storage: new `windows` table** with `chunk_id REFERENCES chunks ON DELETE CASCADE`.
   *Why:* most `chunks` columns (summary, topics, attempts, hash) don't apply to windows.
   Mixing the two in one table would need a filter on every query and would put both kinds in
   one vector index. The cascade deletes a conversation's windows when `/chunk` replaces it.
2. **A window stores its first and last message IDs**, the same way `chunks` does, not its
   rendered text. *Why:* you can still show the exact messages, and stored text can't drift
   from the messages.
3. **8 messages per window, a new window every 4**, so each message appears in two windows. A
   conversation shorter than 8 messages is one window. The last window always ends on the
   conversation's last message. *Why:* a fact split across a window edge still appears whole
   in one window.
4. **Window text reuses the summarizer's line format** ("author: text", latest author names,
   `[link: …]`, `(xN)` repeats), **with no header line**. *Why:* names match the summaries'
   names, and a date or channel header would add noise to short vectors. This means splitting
   the line rendering out of `formatChunkForSummarizing`.
5. **Messages are filtered the same way as for chunking:** no bot messages, and no messages
   that are only GIFs, images or attachments (`textContent` is empty). Indexes count filtered
   messages only.
6. **Every summarized conversation gets windows**, including "low"-substance ones. *Why:* a
   low-substance conversation can still hold the one fact a question is after.
7. **Windows are built in `/summarize`, in a separate pass after summaries**, tracked by their
   own `embedding_model` so a model change re-embeds them. Only conversations that have a
   summary get windows, so every window's parent can be shown with its summary. *Why:* one
   command to run and one progress log.
8. **Window search is a third ranked list in RRF.** Fetch the 150 windows nearest the question,
   go down the list keeping each conversation the first time one of its windows appears, and
   stop at 50 conversations. A conversation's rank is its best window's rank. *Why:* summaries
   and windows have similarity scores on different scales; ranks don't. 150 rather than 50
   because one conversation often has several matching windows.
9. **Weights:** summary 1.0, window **1.0**, keyword **0.25**, with `RRF_K` at **5**.
   *Why:* the best of 114 configurations for broad questions in `npm run eval` (broad MRR 0.92,
   against 0.88 for the earlier 1.0 / 0.5 / 0.5 with `RRF_K` 10). More keyword weight helps
   questions about a specific fact but hurts broad ones.
10. **Each result shows** its channel, date and summary, then the best-matching window's
    messages, then the best keyword match (as now).
11. **`@name` filter for windows:** a window counts if that person wrote any message in its
    parent conversation, whether or not it's inside the window. This is the same filter the
    summary search uses.
12. **A failed window embedding stops the run**, the same way a failed summary embedding does
    now. Each batch is saved before the next one starts. *Why:* `embed()` has already retried
    rate limits and server errors for several minutes by the time it gives up, so the cause is
    almost always shared by every batch (a bad key, a used-up quota, an outage). Carrying on
    would only repeat the same error. Summary *generation* failures still skip one conversation
    and carry on, because those are usually specific to that conversation.
13. Out of scope: an LLM step that answers questions from the results, and tuning weights
    with evaluation questions.

## Acceptance criteria

1. `db/schema.sql` creates a `windows` table (`id`, `chunk_id` with cascade, `channel_id`,
   `first_message_id`, `last_message_id`, `embedding vector(1024)`, `embedding_model`) with an
   HNSW cosine index and an index on `chunk_id`. Applying it to the existing database leaves
   current data untouched.
2. Windowing a list of N filtered messages gives: one window when N ≤ 8; otherwise windows
   starting at 0, 4, 8, … of 8 messages each, with the last window ending on message N−1, and
   no window that's a subset of the previous one.
3. A window's text is the transcript lines only, with no header, and its names, links and `(xN)`
   match what the summarizer sees for those messages.
4. After `/summarize` on a channel, every summarized conversation has windows embedded with
   the current `EMBEDDING_MODEL`. Running it again embeds no new windows.
5. If window embedding fails (after `embed()`'s own retries), the run stops with the error;
   summaries and windows saved so far are kept, and the next run embeds only the missing
   windows.
6. Re-running `/chunk` in a way that deletes or replaces a conversation deletes its windows.
7. `npm run search "<question>"` prints, for a result found through a window, `window #N` in
   its rank list and that window's messages under the summary.
8. A question quoting an exact line that its conversation's summary leaves out returns that
   conversation in the top 10. (Manual check: pick a known line from the database.)
9. `@name` questions only return windows whose parent conversation has a message by that
   person.
10. `npm run build` and lint pass.

## Implementation steps

1. **Schema:** add the `windows` table and indexes to `db/schema.sql`, and apply it.
2. **Window text:** split the line rendering out of `formatChunkForSummarizing` into a shared
   function (summaries unchanged), and add the windowing function (messages → windows) with the
   3a/3b rules.
3. **Storage functions in `db.ts`:** list summarized conversations missing current-model
   windows, and save a conversation's windows with their embeddings in one statement.
4. **`/summarize` pass:** after the summary pass, build and embed windows for pending
   conversations in batches, logging progress the same way summaries do.
5. **Search:** add the window search (150 windows → 50 conversations, `@name` filter), add it
   to `fuse` at weight 1.0, and print the best window under each result.
6. **Check:** run `/summarize` on one channel, then try criterion 8's exact-line question
   and an `@name` question.
