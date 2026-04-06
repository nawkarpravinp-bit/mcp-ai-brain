/**
 * mcp-ai-brain — Database Connection (sql.js)
 *
 * Uses sql.js (pure JS SQLite via WASM) for maximum portability.
 * No native compilation needed — works on any platform.
 *
 * Auto-persists to disk after every write operation.
 */

import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

let _db: SqlJsDatabase | null = null;
let _dbPath: string = "";

/**
 * Resolve the database file path.
 * Priority: BRAIN_DB_PATH env var > ~/.mcp-ai-brain/brain.db
 */
export function resolveDbPath(): string {
  if (process.env.BRAIN_DB_PATH) {
    return process.env.BRAIN_DB_PATH;
  }

  const dir = path.join(os.homedir(), ".mcp-ai-brain");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "brain.db");
}

/**
 * Persist database to disk.
 */
export function persistDb(): void {
  if (_db && _dbPath) {
    const data = _db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(_dbPath, buffer);
  }
}

/**
 * Initialize and return the database connection.
 * Loads existing DB from disk or creates a new one.
 */
export async function initDatabase(): Promise<SqlJsDatabase> {
  if (_db) return _db;

  const SQL = await initSqlJs();
  _dbPath = resolveDbPath();

  let db: SqlJsDatabase;

  if (fs.existsSync(_dbPath)) {
    const fileBuffer = fs.readFileSync(_dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  // Enable WAL-like behavior
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA busy_timeout = 5000;");

  _db = db;
  return db;
}

/**
 * Get the active database instance (must call initDatabase first).
 */
export function getDb(): SqlJsDatabase {
  if (!_db) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return _db;
}

/**
 * Run a write operation and auto-persist.
 */
export function runAndPersist(fn: (db: SqlJsDatabase) => void): void {
  const db = getDb();
  fn(db);
  persistDb();
}

export type { SqlJsDatabase };
