// The one-question-at-a-time lock for /ask. Held in memory: the bot is a single process, and a
// restart clearing it is harmless.

// The display name of the person whose question is being answered, or null when free
let holder: string | null = null;

// Takes the lock for `user` and returns true, or returns false if someone already holds it
// (including `user` themselves)
export function tryAcquire(user: string): boolean {
  if (holder !== null) return false;
  holder = user;
  return true;
}

export function release(): void {
  holder = null;
}

export function currentHolder(): string | null {
  return holder;
}
