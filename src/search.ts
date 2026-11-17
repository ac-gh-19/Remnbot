// Asks a question and prints the 10 conversations that best answer it, found three ways and
// merged: by summary (the question's embedding against each summary's), by window (against
// embeddings of ~8 raw messages at a time, which keep the specifics summaries drop) and by
// keyword (the question's words against the raw messages, which keep names, slang and exact
// wording).
//
//   npm run search "when did we plan the elden ring night?"
//   npm run search "did @ac ever hit 225 bench"     (@name: only conversations that person was in)
//   npm run search                                  (prompts for questions until a blank line)
import { createInterface } from 'node:readline/promises';
import { pool } from './db.js';
import { chunkDetails, fuse, searchLists, windowLines } from './retrieval.js';

const oneLine = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

async function printResults(question: string): Promise<void> {
  const lists = await searchLists(question);
  if (lists.authors) {
    console.log(`Only conversations with ${lists.authors.map(({ name }) => name).join(', ')}\n`);
  }
  const results = fuse(lists);
  if (results.length === 0) {
    console.log('Nothing found. Have the conversations been summarized with /summarize?\n');
    return;
  }

  const details = await chunkDetails(results.map(({ id }) => id));
  const windowTexts = await Promise.all(
    results.map(({ id, window }) => {
      const guildId = details.get(id)?.guildId;
      return window && guildId ? windowLines(window, guildId) : [];
    }),
  );
  results.forEach(({ id, summaryRank, windowRank, keywordRank, bestMatch }, i) => {
    const chunk = details.get(id);
    if (!chunk) return;
    const ranks = [
      summaryRank && `summary #${summaryRank}`,
      windowRank && `window #${windowRank}`,
      keywordRank && `keyword #${keywordRank}`,
    ].filter(Boolean);
    const date = chunk.startedAt.toISOString().slice(0, 10);
    console.log(`${i + 1}. #${chunk.channelName}, ${date}  [${ranks.join(', ')}]`);
    console.log(`   ${chunk.summary}`);
    for (const line of windowTexts[i] ?? []) console.log(`   | ${oneLine(line, 200)}`);
    if (bestMatch) console.log(`   > ${oneLine(bestMatch, 200)}`);
    console.log();
  });
}

try {
  const question = process.argv.slice(2).join(' ').trim();
  if (question) {
    await printResults(question);
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    for (;;) {
      const line = (await rl.question('Question (blank to quit): ')).trim();
      if (!line) break;
      await printResults(line);
    }
    rl.close();
  }
} finally {
  await pool.end();
}
