/**
 * Tool: forget — Soft-delete memories (sql.js compatible)
 */

import type { SqlJsDatabase } from "../db.js";

export interface ForgetInput {
  id: number;
  reason?: string;
}

export interface ForgetResult {
  success: boolean;
  message: string;
}

export function forget(db: SqlJsDatabase, input: ForgetInput): ForgetResult {
  const result = db.exec(
    "SELECT id, content, status FROM memories WHERE id = ?",
    [input.id]
  );

  if (result.length === 0 || result[0].values.length === 0) {
    return { success: false, message: `Memory with id ${input.id} not found.` };
  }

  const row = result[0].values[0];
  const status = row[2] as string;
  const content = row[1] as string;

  if (status === "forgotten") {
    return { success: false, message: `Memory ${input.id} is already forgotten.` };
  }

  db.run(
    "UPDATE memories SET status = 'forgotten', updated_at = datetime('now') WHERE id = ?",
    [input.id]
  );

  const preview = content.length > 80 ? content.substring(0, 80) + "..." : content;

  return {
    success: true,
    message: `Forgotten memory ${input.id}: "${preview}"${input.reason ? ` (reason: ${input.reason})` : ""}`,
  };
}

export function restore(db: SqlJsDatabase, memoryId: number): ForgetResult {
  const result = db.exec("SELECT id, status FROM memories WHERE id = ?", [memoryId]);

  if (result.length === 0 || result[0].values.length === 0) {
    return { success: false, message: `Memory ${memoryId} not found.` };
  }

  const status = result[0].values[0][1] as string;
  if (status === "active") {
    return { success: false, message: `Memory ${memoryId} is already active.` };
  }

  db.run(
    `UPDATE memories SET status = 'active', decay_score = 1.0,
            last_accessed = datetime('now'), updated_at = datetime('now')
     WHERE id = ?`,
    [memoryId]
  );

  return { success: true, message: `Restored memory ${memoryId} to active status.` };
}
