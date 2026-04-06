/**
 * Tool: projects — Project registry (sql.js compatible)
 */

import type { SqlJsDatabase } from "../db.js";

export interface Project {
  id: string;
  name: string;
  description: string;
  metadata: string;
  memory_count: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectCreateInput {
  id: string;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

function rowToProject(row: (string | number | null | Uint8Array)[]): Project {
  return {
    id: row[0] as string,
    name: row[1] as string,
    description: (row[2] as string) ?? "",
    metadata: (row[3] as string) ?? "{}",
    created_at: row[4] as string,
    updated_at: row[5] as string,
    memory_count: (row[6] as number) ?? 0,
  };
}

export function listProjects(db: SqlJsDatabase): Project[] {
  const result = db.exec(`
    SELECT p.id, p.name, p.description, p.metadata, p.created_at, p.updated_at,
           (SELECT COUNT(*) FROM memories m WHERE m.project = p.id AND m.status = 'active') as memory_count
    FROM projects p
    ORDER BY p.updated_at DESC
  `);

  if (result.length === 0) return [];
  return result[0].values.map(rowToProject);
}

export function upsertProject(
  db: SqlJsDatabase,
  input: ProjectCreateInput
): { message: string; project: Project } {
  const existing = db.exec("SELECT id FROM projects WHERE id = ?", [input.id]);
  const exists = existing.length > 0 && existing[0].values.length > 0;

  if (exists) {
    db.run(
      "UPDATE projects SET name = ?, description = ?, metadata = ?, updated_at = datetime('now') WHERE id = ?",
      [input.name, input.description ?? "", JSON.stringify(input.metadata ?? {}), input.id]
    );
  } else {
    db.run(
      "INSERT INTO projects (id, name, description, metadata) VALUES (?, ?, ?, ?)",
      [input.id, input.name, input.description ?? "", JSON.stringify(input.metadata ?? {})]
    );
  }

  const projectResult = db.exec(
    `SELECT p.id, p.name, p.description, p.metadata, p.created_at, p.updated_at,
            (SELECT COUNT(*) FROM memories m WHERE m.project = p.id AND m.status = 'active') as memory_count
     FROM projects p WHERE p.id = ?`,
    [input.id]
  );

  return {
    message: exists ? `Updated project "${input.name}".` : `Created project "${input.name}".`,
    project: rowToProject(projectResult[0].values[0]),
  };
}

export function getProject(db: SqlJsDatabase, projectId: string): Project | null {
  const result = db.exec(
    `SELECT p.id, p.name, p.description, p.metadata, p.created_at, p.updated_at,
            (SELECT COUNT(*) FROM memories m WHERE m.project = p.id AND m.status = 'active') as memory_count
     FROM projects p WHERE p.id = ?`,
    [projectId]
  );

  if (result.length === 0 || result[0].values.length === 0) return null;
  return rowToProject(result[0].values[0]);
}

export function deleteProject(
  db: SqlJsDatabase,
  projectId: string
): { success: boolean; message: string } {
  const result = db.exec("SELECT id, name FROM projects WHERE id = ?", [projectId]);

  if (result.length === 0 || result[0].values.length === 0) {
    return { success: false, message: `Project "${projectId}" not found.` };
  }

  const name = result[0].values[0][1] as string;

  db.run("UPDATE memories SET project = NULL WHERE project = ?", [projectId]);
  db.run("DELETE FROM projects WHERE id = ?", [projectId]);

  return {
    success: true,
    message: `Deleted project "${name}". Its memories are now unscoped.`,
  };
}
