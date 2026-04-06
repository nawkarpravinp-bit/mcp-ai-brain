#!/usr/bin/env node

/**
 * mcp-ai-brain v1.2.0 — Persistent Memory for AI Agents
 *
 * MCP server providing persistent, cross-session memory using
 * SQLite (via sql.js WASM) + keyword search + Ebbinghaus decay.
 *
 * v1.1: Auto-Learning — extracts facts from session summaries
 * v1.2: Proactive Context — workspace-aware smart session start
 *
 * Zero API costs. Local-first. Privacy-focused.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { initDatabase, persistDb, resolveDbPath, type SqlJsDatabase } from "./db.js";
import { migrate } from "./schema.js";
import { remember } from "./tools/remember.js";
import { recall } from "./tools/recall.js";
import { search } from "./tools/search.js";
import { forget, restore } from "./tools/forget.js";
import { sessionStart, sessionEnd } from "./tools/context.js";
import {
  listProjects,
  upsertProject,
  getProject,
  deleteProject,
} from "./tools/projects.js";
import { autoLearn } from "./auto-learn.js";
import { proactiveSessionStart } from "./proactive-context.js";
import { warmupEmbeddings } from "./embeddings.js";

// ──────────────────────────────────────────────────
// Tool Definitions
// ──────────────────────────────────────────────────

const TOOL_DEFINITIONS = [
  {
    name: "brain_remember",
    description:
      "Store a memory in the brain. Use this to persist facts, decisions, architecture patterns, configs, bugs, workflows, and preferences across sessions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        content: {
          type: "string",
          description: "The memory content to store. Be specific and self-contained.",
        },
        project: {
          type: "string",
          description: "Project ID to scope this memory to. Omit for global memories.",
        },
        category: {
          type: "string",
          enum: ["fact", "decision", "preference", "architecture", "bug", "config", "pattern", "incident", "workflow"],
          description: "Memory category. Default: 'fact'.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for searchability.",
        },
        importance: {
          type: "string",
          enum: ["critical", "high", "normal", "low"],
          description: "Importance. 'critical' = never decays. Default: 'normal'.",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "brain_recall",
    description: "Retrieve memories by project, category, or importance. Returns recent, high-relevance memories.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: { type: "string", description: "Filter by project." },
        category: { type: "string", description: "Filter by category." },
        importance: { type: "string", enum: ["critical", "high", "normal", "low"] },
        limit: { type: "number", description: "Max results. Default: 20." },
        include_decayed: { type: "boolean", description: "Include decayed. Default: false." },
      },
    },
  },
  {
    name: "brain_search",
    description: "Search memories using keyword matching. Returns ranked results with decay-adjusted scoring.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query." },
        project: { type: "string", description: "Scope to project." },
        category: { type: "string", description: "Filter by category." },
        limit: { type: "number", description: "Max results. Default: 10." },
      },
      required: ["query"],
    },
  },
  {
    name: "brain_forget",
    description: "Soft-delete a memory by ID. Can be restored later.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "number", description: "Memory ID." },
        reason: { type: "string", description: "Reason for forgetting." },
      },
      required: ["id"],
    },
  },
  {
    name: "brain_restore",
    description: "Restore a forgotten or decayed memory to active status.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "number", description: "Memory ID." },
      },
      required: ["id"],
    },
  },
  {
    name: "brain_session_start",
    description: "Start a basic session. Loads top memories, runs decay maintenance. Use brain_session_start_smart for workspace-aware context.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: { type: "string", description: "Project to load context for." },
        limit: { type: "number", description: "Max memories. Default: 20." },
      },
    },
  },
  {
    name: "brain_session_start_smart",
    description: "[v1.2] Smart session start with workspace auto-detection. Detects project from workspace path, loads file-aware context signals, includes cross-project memories. PREFERRED over brain_session_start.",
    inputSchema: {
      type: "object" as const,
      properties: {
        workspace_path: { type: "string", description: "Active workspace/folder path (e.g., /home/user/projects/my-saas-app). Used to auto-detect project." },
        active_file: { type: "string", description: "Currently open file path. Used for file-aware context (e.g., editing stripe.ts loads payment memories)." },
        project: { type: "string", description: "Explicit project override. If provided, skips auto-detection." },
        limit: { type: "number", description: "Max memories to load. Default: 25." },
      },
    },
  },
  {
    name: "brain_session_end",
    description: "End a session. Records summary, auto-extracts facts from summary (v1.1 Auto-Learning), and stores them as memories.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "string", description: "Session ID from brain_session_start or brain_session_start_smart." },
        summary: { type: "string", description: "What was accomplished. Auto-learning extracts facts from this."},
        project: { type: "string", description: "Project context for auto-learned facts. Falls back to session project." },
      },
      required: ["session_id"],
    },
  },
  {
    name: "brain_auto_learn",
    description: "[v1.1] Manually trigger auto-learning from text. Extracts facts, classifies categories/importance, handles conflicts and deduplication.",
    inputSchema: {
      type: "object" as const,
      properties: {
        text: { type: "string", description: "Text to extract facts from (e.g., meeting notes, session summary, documentation)." },
        project: { type: "string", description: "Project to scope extracted facts to." },
      },
      required: ["text"],
    },
  },
  {
    name: "brain_projects_list",
    description: "List all registered projects with memory counts.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "brain_projects_upsert",
    description: "Create or update a project.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Project ID (e.g., 'my-saas', 'blog-engine')." },
        name: { type: "string", description: "Display name." },
        description: { type: "string", description: "Description." },
      },
      required: ["id", "name"],
    },
  },
  {
    name: "brain_projects_get",
    description: "Get details for a specific project.",
    inputSchema: {
      type: "object" as const,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "brain_projects_delete",
    description: "Delete a project. Memories become unscoped (not deleted).",
    inputSchema: {
      type: "object" as const,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "brain_stats",
    description: "Get brain statistics — memory counts, categories, database info.",
    inputSchema: { type: "object" as const, properties: {} },
  },
];

// ──────────────────────────────────────────────────
// Tool Handler
// ──────────────────────────────────────────────────

async function handleTool(
  db: SqlJsDatabase,
  name: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const json = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  });

  const err = (msg: string) => ({
    content: [{ type: "text" as const, text: msg }],
    isError: true,
  });

  switch (name) {
    case "brain_remember": {
      const result = remember(db, args as unknown as Parameters<typeof remember>[1]);
      persistDb();
      return json(result);
    }

    case "brain_recall": {
      const results = recall(db, args as Parameters<typeof recall>[1]);
      persistDb();
      return json({ count: results.length, memories: results });
    }

    case "brain_search": {
      const results = await search(db, args as unknown as Parameters<typeof search>[1]);
      persistDb();
      return json({ count: results.length, results });
    }

    case "brain_forget": {
      const result = forget(db, args as unknown as Parameters<typeof forget>[1]);
      persistDb();
      return json(result);
    }

    case "brain_restore": {
      const typedArgs = args as { id: number };
      const result = restore(db, typedArgs.id);
      persistDb();
      return json(result);
    }

    case "brain_session_start": {
      const result = sessionStart(db, args as Parameters<typeof sessionStart>[1]);
      persistDb();
      return json(result);
    }

    case "brain_session_start_smart": {
      const result = proactiveSessionStart(db, args as Parameters<typeof proactiveSessionStart>[1]);
      persistDb();
      return json(result);
    }

    case "brain_session_end": {
      const endResult = sessionEnd(db, args as unknown as Parameters<typeof sessionEnd>[1]);

      // v1.1 Auto-Learning: extract facts from summary
      let learnResult = null;
      const typedEndArgs = args as { session_id: string; summary?: string; project?: string };
      if (typedEndArgs.summary && typedEndArgs.summary.length > 20) {
        // Determine project from args or session
        let learnProject = typedEndArgs.project ?? null;
        if (!learnProject) {
          const sessResult = db.exec(
            "SELECT project FROM sessions WHERE id = ?",
            [typedEndArgs.session_id]
          );
          learnProject = (sessResult[0]?.values[0]?.[0] as string) ?? null;
        }
        learnResult = autoLearn(db, typedEndArgs.summary, learnProject);
        persistDb();
      }

      persistDb();
      return json({
        ...endResult,
        auto_learn: learnResult ?? { facts_extracted: 0, facts_stored: 0, message: "No summary provided or too short for auto-learning." },
      });
    }

    case "brain_auto_learn": {
      const typedArgs = args as { text: string; project?: string };
      const result = autoLearn(db, typedArgs.text, typedArgs.project ?? null);
      persistDb();
      return json(result);
    }

    case "brain_projects_list":
      return json({ projects: listProjects(db) });

    case "brain_projects_upsert": {
      const result = upsertProject(db, args as unknown as Parameters<typeof upsertProject>[1]);
      persistDb();
      return json(result);
    }

    case "brain_projects_get": {
      const typedArgs = args as { id: string };
      const project = getProject(db, typedArgs.id);
      if (!project) return err(`Project "${typedArgs.id}" not found.`);
      return json(project);
    }

    case "brain_projects_delete": {
      const typedArgs = args as { id: string };
      const result = deleteProject(db, typedArgs.id);
      persistDb();
      return json(result);
    }

    case "brain_stats":
      return json(getStats(db));

    default:
      return err(`Unknown tool: ${name}`);
  }
}

// ──────────────────────────────────────────────────
// Stats
// ──────────────────────────────────────────────────

function getStats(db: SqlJsDatabase) {
  const count = (sql: string) => {
    const r = db.exec(sql);
    return (r[0]?.values[0]?.[0] as number) ?? 0;
  };

  const categories = db.exec(
    "SELECT category, COUNT(*) FROM memories WHERE status = 'active' GROUP BY category ORDER BY COUNT(*) DESC"
  );

  const projects = db.exec(
    "SELECT project, COUNT(*) FROM memories WHERE status = 'active' AND project IS NOT NULL GROUP BY project ORDER BY COUNT(*) DESC"
  );

  return {
    database: resolveDbPath(),
    memories: {
      total: count("SELECT COUNT(*) FROM memories"),
      active: count("SELECT COUNT(*) FROM memories WHERE status = 'active'"),
      decayed: count("SELECT COUNT(*) FROM memories WHERE status = 'decayed'"),
      forgotten: count("SELECT COUNT(*) FROM memories WHERE status = 'forgotten'"),
    },
    categories: categories[0]?.values.map((r: (string | number | null | Uint8Array)[]) => ({ category: r[0], count: r[1] })) ?? [],
    projects: projects[0]?.values.map((r: (string | number | null | Uint8Array)[]) => ({ project: r[0], count: r[1] })) ?? [],
    sessions: count("SELECT COUNT(*) FROM sessions"),
  };
}

// ──────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────

async function main() {
  // Initialize database
  const db = await initDatabase();
  migrate(db);
  persistDb();

  // Pre-warm embedding model in background (no-op if @xenova/transformers not installed)
  // Ensures model is ready before first brain_remember call arrives
  warmupEmbeddings();

  // Create MCP server
  const server = new Server(
    { name: "mcp-ai-brain", version: "1.1.1" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      return handleTool(db, name, (args ?? {}) as Record<string, unknown>);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`🧠 mcp-ai-brain v1.1.1 | DB: ${resolveDbPath()}`);
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
