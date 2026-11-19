// Records what each /ask Claude call costs, per server, in the usage table. A row is started as
// 'pending' just before the call and finished once it ends; rows a crash leaves 'pending' are
// marked 'interrupted' at startup. Writing a row never throws: a failure is logged and /ask
// carries on, since measuring cost mustn't get in the way of answering.
import { modelPrices } from './config.js';
import { pool } from './db.js';

// Token counts and the model that answered, from a Claude response
export interface CallUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

export interface UsageTotals {
  questions: number;
  costMicroUsd: number;
  // Finished rows with no cost: interrupted, or a model missing from the price table
  unknownCost: number;
}

// Cost in micro-dollars (millionths of a dollar), or null for a model with no price. A token at
// $X per million costs X micro-dollars, so the price table's numbers apply directly.
export function costMicroUsd(usage: CallUsage): number | null {
  const price = modelPrices[usage.model];
  if (!price) return null;
  return Math.round(
    usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheWriteTokens * price.cacheWrite +
      usage.cacheReadTokens * price.cacheRead,
  );
}

// Inserts a 'pending' row; returns its ID, or null if it couldn't be written
export async function startUsage(guildId: string): Promise<string | null> {
  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO usage (guild_id, kind) VALUES ($1, 'ask') RETURNING id`,
      [guildId],
    );
    return rows[0]?.id ?? null;
  } catch (error) {
    console.error('[usage] Could not start a usage row:', error);
    return null;
  }
}

// Marks the row 'done' or 'failed' with its tokens and cost
export async function finishUsage(
  id: string | null,
  status: 'done' | 'failed',
  usage: CallUsage,
): Promise<void> {
  if (id === null) return;
  const cost = costMicroUsd(usage);
  if (cost === null) {
    console.warn(`[usage] No price for model ${usage.model}; row ${id} saved without a cost`);
  }
  try {
    await pool.query(
      `UPDATE usage SET status = $2, finished_at = now(), model = $3, input_tokens = $4,
         output_tokens = $5, cache_write_tokens = $6, cache_read_tokens = $7, cost_micro_usd = $8
       WHERE id = $1`,
      [
        id,
        status,
        usage.model,
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheWriteTokens,
        usage.cacheReadTokens,
        cost,
      ],
    );
  } catch (error) {
    console.error(`[usage] Could not finish usage row ${id}:`, error);
  }
}

// Marks the row 'interrupted': the call ended with no response to read tokens from
export async function interruptUsage(id: string | null): Promise<void> {
  if (id === null) return;
  try {
    await pool.query(`UPDATE usage SET status = 'interrupted', finished_at = now() WHERE id = $1`, [
      id,
    ]);
  } catch (error) {
    console.error(`[usage] Could not mark usage row ${id} interrupted:`, error);
  }
}

// Run at startup: the bot is one process, so no call can be in flight yet and any 'pending' row
// was left by a crash
export async function sweepPendingUsage(): Promise<void> {
  try {
    const { rowCount } = await pool.query(
      `UPDATE usage SET status = 'interrupted', finished_at = now() WHERE status = 'pending'`,
    );
    if (rowCount) console.log(`[usage] Marked ${rowCount} unfinished row(s) interrupted`);
  } catch (error) {
    console.error('[usage] Could not sweep pending usage rows:', error);
  }
}

// A server's totals since `since` (all time when null). Throws if the query fails, since /usage
// has nothing to show without it.
export async function usageTotals(guildId: string, since: Date | null): Promise<UsageTotals> {
  const { rows } = await pool.query<{
    questions: number;
    cost: string;
    unknown_cost: number;
  }>(
    `SELECT count(*)::int AS questions,
            coalesce(sum(cost_micro_usd), 0)::bigint AS cost,
            (count(*) FILTER (WHERE status <> 'pending' AND cost_micro_usd IS NULL))::int AS unknown_cost
     FROM usage
     WHERE guild_id = $1 AND ($2::timestamptz IS NULL OR started_at >= $2)`,
    [guildId, since?.toISOString() ?? null],
  );
  const row = rows[0];
  return {
    questions: row?.questions ?? 0,
    costMicroUsd: Number(row?.cost ?? 0),
    unknownCost: row?.unknown_cost ?? 0,
  };
}
