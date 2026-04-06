/**
 * Tool: context — Session lifecycle (sql.js compatible)
 */

import type { SqlJsDatabase } from "../db.js";
import { recallMemories, type SearchResult } from "../hybrid-search.js";
import { runDecayPass } from "../decay.js";
import { randomUUID } from "node:crypto";

export interface SessionStartInput {
  project?: string;
  limit?: number;
}

export interface SessionStartResult {
  session_id: string;
  memories: SearchResult[];
  stats: {
    total_memories: number;
    active_memories: number;
    project_memories: number;
    decay_pass: { updated: number; decayed: number };
  };
}

export interface SessionEndInput {
  session_id: string;
  summary?: string;
}

export interface SessionEndResult {
  message: string;
  session_id: string;
  duration_minutes: number;
}

export function sessionStart(
  db: SqlJsDatabase,
  input: SessionStartInput
): SessionStartResult {
  const { project = null, limit = 20 } = input;

  const decayResult = runDecayPass(db);

  const sessionId = randomUUID();
  db.run(
    "INSERT INTO sessions (id, project, started_at) VALUES (?, ?, datetime('now'))",
    [sessionId, project]
  );

  // Load critical memories first
  const criticalMemories = recallMemories(db, {
    project,
    importance: "critical",
    limit: Math.ceil(limit / 2),
  });

  const recentMemories = recallMemories(db, {
    project,
    limit: limit - criticalMemories.length,
  });

  const seenIds = new Set(criticalMemories.map((m) => m.id));
  const uniqueRecent = recentMemories.filter((m) => !seenIds.has(m.id));
  const memories = [...criticalMemories, ...uniqueRecent].slice(0, limit);

  // Stats
  const totalResult = db.exec("SELECT COUNT(*) FROM memories");
  const total = (totalResult[0]?.values[0]?.[0] as number) ?? 0;

  const activeResult = db.exec(
    "SELECT COUNT(*) FROM memories WHERE status = 'active'"
  );
  const active = (activeResult[0]?.values[0]?.[0] as number) ?? 0;

  let projectCount = 0;
  if (project) {
    const projResult = db.exec(
      "SELECT COUNT(*) FROM memories WHERE project = ? AND status = 'active'",
      [project]
    );
    projectCount = (projResult[0]?.values[0]?.[0] as number) ?? 0;
  }

  db.run("UPDATE sessions SET memories_accessed = ? WHERE id = ?", [
    memories.length,
    sessionId,
  ]);

  return {
    session_id: sessionId,
    memories,
    stats: {
      total_memories: total,
      active_memories: active,
      project_memories: projectCount,
      decay_pass: decayResult,
    },
  };
}

export function sessionEnd(
  db: SqlJsDatabase,
  input: SessionEndInput
): SessionEndResult {
  const result = db.exec(
    "SELECT id, started_at FROM sessions WHERE id = ?",
    [input.session_id]
  );

  if (result.length === 0 || result[0].values.length === 0) {
    return {
      message: `Session ${input.session_id} not found.`,
      session_id: input.session_id,
      duration_minutes: 0,
    };
  }

  const startedAt = result[0].values[0][1] as string;

  const memoriesResult = db.exec(
    "SELECT COUNT(*) FROM memories WHERE created_at >= ? AND created_at <= datetime('now')",
    [startedAt]
  );
  const memoriesCreated = (memoriesResult[0]?.values[0]?.[0] as number) ?? 0;

  db.run(
    "UPDATE sessions SET summary = ?, ended_at = datetime('now'), memories_created = ? WHERE id = ?",
    [input.summary ?? null, memoriesCreated, input.session_id]
  );

  const startTime = new Date(startedAt + "Z").getTime();
  const durationMinutes = Math.round((Date.now() - startTime) / 60000);

  return {
    message: `Session ended. Duration: ${durationMinutes}min, Memories created: ${memoriesCreated}.`,
    session_id: input.session_id,
    duration_minutes: durationMinutes,
  };
}
