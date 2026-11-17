import { formatTranscriptLines, type ChatMessage, type MentionNames } from './embedding.js';

// Messages per window, and how far each window starts after the previous one. With a step of
// half the size, each message is in two windows, so a fact split across one window's edge
// appears whole in the next.
export const WINDOW_SIZE = 8;
export const WINDOW_STEP = 4;

// The [start, end) ranges that cut `count` messages into windows. Fewer than WINDOW_SIZE
// messages make one window. Otherwise windows start every WINDOW_STEP messages, and the last
// window is moved back to end on the last message, so the tail is never a shorter window or one
// already covered by the window before it.
export function windowRanges(count: number): [start: number, end: number][] {
  if (count === 0) return [];
  if (count <= WINDOW_SIZE) return [[0, count]];

  const ranges: [number, number][] = [];
  for (let start = 0; start + WINDOW_SIZE < count; start += WINDOW_STEP) {
    ranges.push([start, start + WINDOW_SIZE]);
  }
  ranges.push([count - WINDOW_SIZE, count]);
  return ranges;
}

export interface Window {
  firstMessageId: string;
  lastMessageId: string;
  // The transcript lines, with no header: what gets embedded
  text: string;
}

// Cuts a chunk's messages into windows. `messages` must already be filtered the way /chunk
// filters them (no bots, no messages that are only media), so window positions count the same
// messages the chunk does.
export function buildWindows(
  messages: (ChatMessage & { id: string })[],
  names: MentionNames,
): Window[] {
  return windowRanges(messages.length).flatMap(([start, end]) => {
    const slice = messages.slice(start, end);
    const first = slice[0];
    const last = slice.at(-1);
    if (!first || !last) return [];
    return [
      {
        firstMessageId: first.id,
        lastMessageId: last.id,
        text: formatTranscriptLines(slice, names).join('\n'),
      },
    ];
  });
}
