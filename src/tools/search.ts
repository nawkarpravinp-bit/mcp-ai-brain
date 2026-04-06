/**
 * Tool: search — Hybrid search (sql.js compatible)
 */

import type { SqlJsDatabase } from "../db.js";
import { hybridSearch, type SearchResult } from "../hybrid-search.js";

export interface SearchInput {
  query: string;
  project?: string;
  category?: string;
  limit?: number;
}

export function search(db: SqlJsDatabase, input: SearchInput): SearchResult[] {
  return hybridSearch(db, input.query, {
    project: input.project ?? null,
    limit: input.limit ?? 10,
    category: input.category,
  });
}
