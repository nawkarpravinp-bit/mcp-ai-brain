/**
 * Tool: recall — Retrieve memories by filter (sql.js compatible)
 */

import type { SqlJsDatabase } from "../db.js";
import { recallMemories, type SearchResult } from "../hybrid-search.js";

export interface RecallInput {
  project?: string;
  category?: string;
  importance?: string;
  limit?: number;
  include_decayed?: boolean;
}

export function recall(db: SqlJsDatabase, input: RecallInput): SearchResult[] {
  return recallMemories(db, {
    project: input.project ?? null,
    category: input.category,
    importance: input.importance,
    limit: input.limit ?? 20,
    includeDecayed: input.include_decayed ?? false,
  });
}
