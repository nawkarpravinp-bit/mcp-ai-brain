/**
 * mcp-ai-brain — Memory Decay Engine (sql.js compatible)
 *
 * Implements Ebbinghaus-inspired forgetting curve.
 */

import type { SqlJsDatabase } from "./db.js";

const DECAY_CONFIG = {
  gracePeriodDays: 7,
  decayFloor: 0.1,
  importanceWeights: {
    critical: 0,
    high: 0.25,
    normal: 1.0,
    low: 2.0,
  } as Record<string, number>,
};

export function calculateDecayScore(
  daysSinceAccess: number,
  accessCount: number,
  importance: string
): number {
  const weight =
    DECAY_CONFIG.importanceWeights[importance] ??
    DECAY_CONFIG.importanceWeights.normal;

  if (weight === 0) return 1.0;
  if (daysSinceAccess <= DECAY_CONFIG.gracePeriodDays) return 1.0;

  const effectiveDays = daysSinceAccess - DECAY_CONFIG.gracePeriodDays;
  const accessBuffer = Math.log2(Math.max(accessCount, 1) + 1);
  const decayRate = weight * 0.05;
  const score = accessBuffer / (accessBuffer + decayRate * effectiveDays);

  return Math.max(score, 0);
}

export function runDecayPass(
  db: SqlJsDatabase
): { updated: number; decayed: number } {
  const result = db.exec(`
    SELECT id, importance, access_count,
           CAST((julianday('now') - julianday(last_accessed)) AS REAL) as days_since_access
    FROM memories
    WHERE status = 'active' AND importance != 'critical'
  `);

  let updated = 0;
  let decayed = 0;

  if (result.length === 0 || result[0].values.length === 0) {
    return { updated, decayed };
  }

  for (const row of result[0].values) {
    const id = row[0] as number;
    const importance = row[1] as string;
    const accessCount = row[2] as number;
    const daysSinceAccess = row[3] as number;

    const score = calculateDecayScore(daysSinceAccess, accessCount, importance);

    if (score <= DECAY_CONFIG.decayFloor) {
      db.run(
        "UPDATE memories SET status = 'decayed', decay_score = ?, updated_at = datetime('now') WHERE id = ?",
        [score, id]
      );
      decayed++;
    } else {
      db.run(
        "UPDATE memories SET decay_score = ?, updated_at = datetime('now') WHERE id = ?",
        [score, id]
      );
    }
    updated++;
  }

  return { updated, decayed };
}

export function touchMemory(db: SqlJsDatabase, memoryId: number): void {
  // Get content length for accurate token counting
  const contentResult = db.exec(
    "SELECT LENGTH(content) FROM memories WHERE id = ?",
    [memoryId]
  );
  const contentLen = (contentResult[0]?.values[0]?.[0] as number) ?? 0;
  const tokensForThisAccess = Math.ceil(contentLen / 4);

  // Update memory access metadata
  db.run(
    `UPDATE memories
     SET access_count = access_count + 1,
         last_accessed = datetime('now'),
         decay_score = 1.0,
         updated_at = datetime('now')
     WHERE id = ?`,
    [memoryId]
  );

  // Atomically increment the exact tokens_saved counter
  db.run(
    `UPDATE metrics
     SET value_int = value_int + ?,
         updated_at = datetime('now')
     WHERE key = 'tokens_saved'`,
    [tokensForThisAccess]
  );

  // Increment total recalls counter
  db.run(
    `UPDATE metrics
     SET value_int = value_int + 1,
         updated_at = datetime('now')
     WHERE key = 'total_recalls'`
  );
}

export { DECAY_CONFIG };
