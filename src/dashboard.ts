#!/usr/bin/env node

/**
 * mcp-ai-brain Dashboard — localhost:3333
 *
 * Standalone web dashboard for viewing, searching, and managing
 * brain memories. Uses built-in Node HTTP server + sql.js.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { initDatabase, persistDb, resolveDbPath, type SqlJsDatabase } from "./db.js";
import { migrate } from "./schema.js";
import { hybridSearch, recallMemories } from "./hybrid-search.js";
import { runDecayPass } from "./decay.js";
import { remember } from "./tools/remember.js";
import { forget, restore } from "./tools/forget.js";
import { listProjects } from "./tools/projects.js";

const PORT = parseInt(process.env.BRAIN_DASHBOARD_PORT ?? "3333", 10);

// ──────────────────────────────────────────────────
// API Routes
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
  const importanceDist = db.exec(
    "SELECT importance, COUNT(*) FROM memories WHERE status = 'active' GROUP BY importance"
  );
  const recentMemories = db.exec(
    "SELECT id, content, project, category, importance, decay_score, access_count, created_at FROM memories WHERE status = 'active' ORDER BY created_at DESC LIMIT 10"
  );

  // Tokens Saved — read EXACT counter from metrics table
  // This is atomically incremented on every memory access in touchMemory()
  const tokensSavedResult = db.exec(
    "SELECT value_int FROM metrics WHERE key = 'tokens_saved'"
  );
  const tokensSaved = (tokensSavedResult[0]?.values[0]?.[0] as number) ?? 0;

  // Total recall operations
  const totalRecallsResult = db.exec(
    "SELECT value_int FROM metrics WHERE key = 'total_recalls'"
  );
  const totalAccesses = (totalRecallsResult[0]?.values[0]?.[0] as number) ?? 0;

  return {
    database: resolveDbPath(),
    memories: {
      total: count("SELECT COUNT(*) FROM memories"),
      active: count("SELECT COUNT(*) FROM memories WHERE status = 'active'"),
      decayed: count("SELECT COUNT(*) FROM memories WHERE status = 'decayed'"),
      forgotten: count("SELECT COUNT(*) FROM memories WHERE status = 'forgotten'"),
    },
    tokensSaved,
    totalAccesses,
    // Estimated cost saved (at ~$0.10 per 1K input tokens for premium models)
    estimatedCostSaved: parseFloat((tokensSaved * 0.0001).toFixed(2)),
    categories: categories[0]?.values.map((r: any[]) => ({ name: r[0], count: r[1] })) ?? [],
    projects: projects[0]?.values.map((r: any[]) => ({ name: r[0], count: r[1] })) ?? [],
    importance: importanceDist[0]?.values.map((r: any[]) => ({ level: r[0], count: r[1] })) ?? [],
    recent: recentMemories[0]?.values.map((r: any[]) => ({
      id: r[0], content: r[1], project: r[2], category: r[3],
      importance: r[4], decay_score: r[5], access_count: r[6], created_at: r[7],
    })) ?? [],
    sessions: count("SELECT COUNT(*) FROM sessions"),
  };
}

function getAllMemories(db: SqlJsDatabase, query: URLSearchParams) {
  const project = query.get("project") || undefined;
  const category = query.get("category") || undefined;
  const importance = query.get("importance") || undefined;
  const status = query.get("status") || "active";
  const limit = parseInt(query.get("limit") ?? "50", 10);
  const offset = parseInt(query.get("offset") ?? "0", 10);

  let sql = `SELECT id, content, project, category, tags, importance, decay_score, access_count, status, created_at, updated_at FROM memories WHERE 1=1`;
  const params: (string | number)[] = [];

  if (status !== "all") { sql += " AND status = ?"; params.push(status); }
  if (project) { sql += " AND project = ?"; params.push(project); }
  if (category) { sql += " AND category = ?"; params.push(category); }
  if (importance) { sql += " AND importance = ?"; params.push(importance); }

  const countSql = sql.replace(/SELECT .+ FROM/, "SELECT COUNT(*) FROM");
  const totalResult = db.exec(countSql, params);
  const total = (totalResult[0]?.values[0]?.[0] as number) ?? 0;

  sql += " ORDER BY updated_at DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);

  const result = db.exec(sql, params);
  const memories = result[0]?.values.map((r: any[]) => ({
    id: r[0], content: r[1], project: r[2], category: r[3], tags: r[4],
    importance: r[5], decay_score: r[6], access_count: r[7], status: r[8],
    created_at: r[9], updated_at: r[10],
  })) ?? [];

  return { total, memories, limit, offset };
}

async function handleApi(
  db: SqlJsDatabase,
  path: string,
  query: URLSearchParams,
  method: string,
  body: any
): Promise<any> {
  switch (`${method} ${path}`) {
    case "GET /api/stats":
      return getStats(db);
    case "GET /api/memories":
      return getAllMemories(db, query);
    case "GET /api/search":
      return { results: hybridSearch(db, query.get("q") ?? "", {
        project: query.get("project") || null,
        category: query.get("category") || undefined,
        limit: parseInt(query.get("limit") ?? "20", 10),
      })};
    case "GET /api/projects":
      return { projects: listProjects(db) };
    case "POST /api/remember":
      const result = remember(db, body);
      persistDb();
      return result;
    case "POST /api/forget":
      const fResult = forget(db, body);
      persistDb();
      return fResult;
    case "POST /api/restore":
      const rResult = restore(db, body.id);
      persistDb();
      return rResult;
    case "POST /api/decay":
      const dResult = runDecayPass(db);
      persistDb();
      return dResult;
    default:
      return null;
  }
}

// ──────────────────────────────────────────────────
// HTML Dashboard
// ──────────────────────────────────────────────────

function dashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>🧠 mcp-ai-brain Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#0a0a0f;--surface:#12121a;--surface2:#1a1a28;--surface3:#222236;
  --border:#2a2a40;--border-accent:#3d3d5c;
  --text:#e8e8f0;--text-dim:#8888a8;--text-muted:#5a5a78;
  --accent:#6c5ce7;--accent2:#a29bfe;--accent3:#00cec9;
  --green:#00b894;--red:#ff6b6b;--yellow:#feca57;--orange:#ff9f43;
  --cyan:#00cec9;--pink:#fd79a8;
  --radius:12px;--radius-sm:8px;
}
body{font-family:'Inter',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;overflow-x:hidden}
a{color:var(--accent2);text-decoration:none}
.app{max-width:1400px;margin:0 auto;padding:24px}

/* Header */
.header{display:flex;align-items:center;justify-content:space-between;padding:20px 0 32px;border-bottom:1px solid var(--border);margin-bottom:32px}
.header h1{font-size:28px;font-weight:800;background:linear-gradient(135deg,var(--accent),var(--accent3));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.header .subtitle{font-size:13px;color:var(--text-muted);margin-top:4px;font-weight:400}
.header .db-path{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text-muted);background:var(--surface2);padding:6px 12px;border-radius:6px}

/* Stats Grid */
.stats-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:16px;margin-bottom:32px}
.stat-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;position:relative;overflow:hidden;transition:border-color .2s,transform .15s}
.stat-card:hover{border-color:var(--accent);transform:translateY(-2px)}
.stat-card::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;border-radius:var(--radius) var(--radius) 0 0}
.stat-card:nth-child(1)::before{background:linear-gradient(90deg,var(--accent),var(--accent2))}
.stat-card:nth-child(2)::before{background:linear-gradient(90deg,var(--green),var(--cyan))}
.stat-card:nth-child(3)::before{background:linear-gradient(90deg,var(--yellow),var(--orange))}
.stat-card:nth-child(4)::before{background:linear-gradient(90deg,var(--pink),var(--red))}
.stat-card:nth-child(5)::before{background:linear-gradient(90deg,var(--cyan),var(--green))}
.stat-card .label{font-size:12px;color:var(--text-muted);text-transform:uppercase;letter-spacing:1.5px;font-weight:600}
.stat-card .value{font-size:36px;font-weight:800;margin-top:8px;font-variant-numeric:tabular-nums}
.stat-card .sub{font-size:12px;color:var(--text-muted);margin-top:4px}
.stat-card:nth-child(1) .value{color:var(--accent2)}
.stat-card:nth-child(2) .value{color:var(--green)}
.stat-card:nth-child(3) .value{color:var(--yellow)}
.stat-card:nth-child(4) .value{color:var(--pink)}
.stat-card:nth-child(5) .value{color:var(--cyan)}

/* Panels */
.panels{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:32px}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
.panel-header{padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
.panel-header h2{font-size:15px;font-weight:700;color:var(--text)}
.panel-header .badge{font-size:11px;background:var(--surface3);color:var(--accent2);padding:3px 10px;border-radius:12px;font-weight:600}
.panel-body{padding:16px 20px}

/* Bar Chart */
.bar-row{display:flex;align-items:center;gap:12px;margin-bottom:10px}
.bar-label{width:100px;font-size:12px;color:var(--text-dim);text-align:right;font-weight:500;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar-track{flex:1;height:24px;background:var(--surface2);border-radius:6px;overflow:hidden;position:relative}
.bar-fill{height:100%;border-radius:6px;transition:width .6s cubic-bezier(.4,0,.2,1);display:flex;align-items:center;padding:0 8px;font-size:11px;font-weight:600;color:white;min-width:28px}
.bar-fill.cat{background:linear-gradient(90deg,var(--accent),var(--accent2))}
.bar-fill.proj{background:linear-gradient(90deg,var(--green),var(--cyan))}

/* Search */
.search-section{margin-bottom:32px}
.search-bar{display:flex;gap:12px;margin-bottom:20px}
.search-input{flex:1;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 20px;font-size:15px;color:var(--text);font-family:inherit;outline:none;transition:border-color .2s}
.search-input:focus{border-color:var(--accent)}
.search-input::placeholder{color:var(--text-muted)}
.search-btn{background:linear-gradient(135deg,var(--accent),var(--accent2));color:white;border:none;padding:14px 28px;border-radius:var(--radius);font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;transition:transform .15s,box-shadow .2s}
.search-btn:hover{transform:translateY(-1px);box-shadow:0 4px 20px rgba(108,92,231,.4)}
.search-filters{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}
.filter-select{background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px 14px;font-size:13px;color:var(--text);font-family:inherit;outline:none;cursor:pointer}
.filter-select:focus{border-color:var(--accent)}

/* Memory Table */
.memory-table{width:100%;border-collapse:separate;border-spacing:0}
.memory-table th{font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-muted);font-weight:600;padding:10px 16px;text-align:left;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--surface)}
.memory-table td{padding:12px 16px;border-bottom:1px solid var(--border);font-size:13px;vertical-align:top}
.memory-table tr:hover td{background:var(--surface2)}
.memory-table .content-cell{max-width:500px;line-height:1.5}
.memory-table .content-preview{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.pill{display:inline-block;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600}
.pill-critical{background:rgba(255,107,107,.15);color:var(--red)}
.pill-high{background:rgba(255,159,67,.15);color:var(--orange)}
.pill-normal{background:rgba(136,136,168,.15);color:var(--text-dim)}
.pill-low{background:rgba(90,90,120,.1);color:var(--text-muted)}
.pill-cat{background:rgba(108,92,231,.15);color:var(--accent2)}
.pill-proj{background:rgba(0,206,201,.15);color:var(--cyan)}
.decay-bar{width:60px;height:6px;background:var(--surface3);border-radius:3px;overflow:hidden}
.decay-fill{height:100%;border-radius:3px;transition:width .3s}
.action-btn{background:none;border:1px solid var(--border);color:var(--text-dim);padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer;font-family:inherit;transition:all .15s}
.action-btn:hover{border-color:var(--accent);color:var(--accent2)}
.action-btn.danger:hover{border-color:var(--red);color:var(--red)}

/* Pagination */
.pagination{display:flex;align-items:center;justify-content:space-between;padding:16px 0}
.pagination .info{font-size:13px;color:var(--text-muted)}
.pagination .controls{display:flex;gap:8px}
.page-btn{background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:8px 16px;border-radius:var(--radius-sm);font-size:13px;cursor:pointer;font-family:inherit;transition:all .15s}
.page-btn:hover:not(:disabled){border-color:var(--accent);color:var(--accent2)}
.page-btn:disabled{opacity:.4;cursor:not-allowed}

/* Memory Detail Modal */
.modal-overlay{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.7);z-index:100;backdrop-filter:blur(4px);align-items:center;justify-content:center}
.modal-overlay.active{display:flex}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:16px;width:90%;max-width:700px;max-height:85vh;overflow-y:auto;padding:28px}
.modal h3{font-size:18px;font-weight:700;margin-bottom:16px;display:flex;align-items:center;gap:10px}
.modal .close-btn{margin-left:auto;background:none;border:none;color:var(--text-muted);font-size:22px;cursor:pointer}
.modal .meta-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px}
.modal .meta-item{background:var(--surface2);border-radius:var(--radius-sm);padding:12px}
.modal .meta-item .meta-label{font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px}
.modal .meta-item .meta-value{font-size:14px;font-weight:500}
.modal .content-full{background:var(--surface2);border-radius:var(--radius-sm);padding:16px;font-size:14px;line-height:1.7;white-space:pre-wrap;word-break:break-word;font-family:'JetBrains Mono','Inter',monospace;max-height:300px;overflow-y:auto}

/* Toast */
.toast{position:fixed;bottom:24px;right:24px;background:var(--green);color:white;padding:12px 24px;border-radius:var(--radius-sm);font-size:14px;font-weight:600;z-index:200;transform:translateY(100px);opacity:0;transition:all .3s}
.toast.show{transform:translateY(0);opacity:1}
.toast.error{background:var(--red)}

/* Add Memory */
.add-form{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:24px;margin-bottom:32px;display:none}
.add-form.open{display:block}
.add-form h2{font-size:16px;font-weight:700;margin-bottom:16px}
.form-row{display:flex;gap:12px;margin-bottom:12px}
.form-group{flex:1}
.form-group label{display:block;font-size:12px;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;font-weight:600}
.form-group textarea,.form-group input,.form-group select{width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 14px;font-size:14px;color:var(--text);font-family:inherit;outline:none;resize:vertical}
.form-group textarea:focus,.form-group input:focus{border-color:var(--accent)}
.form-group textarea{min-height:80px}

.toggle-add{background:none;border:1px dashed var(--border);color:var(--text-dim);width:100%;padding:14px;border-radius:var(--radius);font-size:14px;cursor:pointer;font-family:inherit;margin-bottom:16px;transition:all .2s}
.toggle-add:hover{border-color:var(--accent);color:var(--accent2)}

@media(max-width:900px){
  .stats-grid{grid-template-columns:repeat(2,1fr)}
  .panels{grid-template-columns:1fr}
  .search-bar{flex-direction:column}
}
@media(max-width:600px){
  .stats-grid{grid-template-columns:1fr}
  .app{padding:16px}
}
</style>
</head>
<body>
<div class="app">
  <div class="header">
    <div>
      <h1>🧠 mcp-ai-brain</h1>
      <div class="subtitle">Persistent Memory for AI Agents — v1.0.0</div>
    </div>
    <div class="db-path" id="dbPath"></div>
  </div>

  <!-- Stats -->
  <div class="stats-grid" id="statsGrid">
    <div class="stat-card"><div class="label">Total Memories</div><div class="value" id="statTotal">—</div></div>
    <div class="stat-card"><div class="label">Active</div><div class="value" id="statActive">—</div></div>
    <div class="stat-card"><div class="label">Decayed</div><div class="value" id="statDecayed">—</div></div>
    <div class="stat-card"><div class="label">Sessions</div><div class="value" id="statSessions">—</div></div>
    <div class="stat-card"><div class="label">Tokens Saved</div><div class="value" id="statTokens">—</div><div class="sub" id="statCost">~$0 saved</div></div>
  </div>

  <!-- Panels -->
  <div class="panels">
    <div class="panel">
      <div class="panel-header"><h2>📂 Projects</h2><span class="badge" id="projectCount">0</span></div>
      <div class="panel-body" id="projectBars"></div>
    </div>
    <div class="panel">
      <div class="panel-header"><h2>🏷️ Categories</h2><span class="badge" id="categoryCount">0</span></div>
      <div class="panel-body" id="categoryBars"></div>
    </div>
  </div>

  <!-- Add Memory -->
  <button class="toggle-add" onclick="toggleAddForm()">＋ Add New Memory</button>
  <div class="add-form" id="addForm">
    <h2>New Memory</h2>
    <div class="form-group" style="margin-bottom:12px">
      <label>Content</label>
      <textarea id="newContent" placeholder="What should I remember?"></textarea>
    </div>
    <div class="form-row">
      <div class="form-group"><label>Project</label><select id="newProject"><option value="">Global</option></select></div>
      <div class="form-group"><label>Category</label><select id="newCategory">
        <option value="fact">fact</option><option value="decision">decision</option><option value="preference">preference</option>
        <option value="architecture">architecture</option><option value="bug">bug</option><option value="config">config</option>
        <option value="pattern">pattern</option><option value="incident">incident</option><option value="workflow">workflow</option>
      </select></div>
      <div class="form-group"><label>Importance</label><select id="newImportance">
        <option value="normal">normal</option><option value="critical">critical</option>
        <option value="high">high</option><option value="low">low</option>
      </select></div>
    </div>
    <div class="form-group" style="margin-bottom:12px"><label>Tags (comma-separated)</label><input id="newTags" placeholder="e.g. firebase, auth, bugfix"></div>
    <button class="search-btn" onclick="addMemory()">Remember</button>
  </div>

  <!-- Search -->
  <div class="search-section">
    <div class="search-bar">
      <input class="search-input" id="searchInput" placeholder="Search memories..." onkeydown="if(event.key==='Enter')doSearch()">
      <button class="search-btn" onclick="doSearch()">Search</button>
    </div>
    <div class="search-filters">
      <select class="filter-select" id="filterProject" onchange="loadMemories()"><option value="">All Projects</option></select>
      <select class="filter-select" id="filterCategory" onchange="loadMemories()">
        <option value="">All Categories</option>
        <option>fact</option><option>decision</option><option>preference</option><option>architecture</option>
        <option>bug</option><option>config</option><option>pattern</option><option>incident</option><option>workflow</option>
      </select>
      <select class="filter-select" id="filterImportance" onchange="loadMemories()">
        <option value="">All Importance</option>
        <option>critical</option><option>high</option><option>normal</option><option>low</option>
      </select>
      <select class="filter-select" id="filterStatus" onchange="loadMemories()">
        <option value="active">Active</option><option value="all">All</option>
        <option value="decayed">Decayed</option><option value="forgotten">Forgotten</option>
      </select>
    </div>
  </div>

  <!-- Memories Table -->
  <div class="panel" style="margin-bottom:16px">
    <div class="panel-header"><h2>💾 Memories</h2><span class="badge" id="memoryCount">0</span></div>
    <div style="overflow-x:auto">
      <table class="memory-table">
        <thead><tr>
          <th>ID</th><th>Content</th><th>Project</th><th>Category</th>
          <th>Importance</th><th>Decay</th><th>Access</th><th>Created</th><th></th>
        </tr></thead>
        <tbody id="memoryBody"></tbody>
      </table>
    </div>
    <div class="pagination">
      <div class="info" id="pageInfo">—</div>
      <div class="controls">
        <button class="page-btn" id="prevBtn" onclick="prevPage()" disabled>← Prev</button>
        <button class="page-btn" id="nextBtn" onclick="nextPage()">Next →</button>
      </div>
    </div>
  </div>
</div>

<!-- Modal -->
<div class="modal-overlay" id="modal" onclick="if(event.target===this)closeModal()">
  <div class="modal">
    <h3><span id="modalTitle">Memory</span><button class="close-btn" onclick="closeModal()">✕</button></h3>
    <div class="meta-grid" id="modalMeta"></div>
    <div class="content-full" id="modalContent"></div>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
let currentPage=0,pageSize=50,totalMemories=0,isSearchMode=false;

async function api(path){const r=await fetch(path);return r.json()}
async function apiPost(path,body){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return r.json()}

function toast(msg,error=false){
  const t=document.getElementById('toast');
  t.textContent=msg;t.className='toast'+(error?' error':'')+' show';
  setTimeout(()=>t.className='toast',3000);
}

function decayColor(score){
  if(score>=.8)return'var(--green)';if(score>=.5)return'var(--yellow)';return'var(--red)';
}

function timeSince(dateStr){
  const s=Math.floor((Date.now()-new Date(dateStr+'Z').getTime())/1000);
  if(s<60)return s+'s ago';if(s<3600)return Math.floor(s/60)+'m ago';
  if(s<86400)return Math.floor(s/3600)+'h ago';return Math.floor(s/86400)+'d ago';
}

async function loadStats(){
  const stats=await api('/api/stats');
  document.getElementById('dbPath').textContent=stats.database;
  document.getElementById('statTotal').textContent=stats.memories.total;
  document.getElementById('statActive').textContent=stats.memories.active;
  document.getElementById('statDecayed').textContent=stats.memories.decayed;
  document.getElementById('statSessions').textContent=stats.sessions;

  // Tokens saved
  const ts=stats.tokensSaved||0;
  document.getElementById('statTokens').textContent=ts>=1000?(ts/1000).toFixed(1)+'K':ts;
  document.getElementById('statCost').textContent='~$'+stats.estimatedCostSaved+' saved';

  // Project bars
  document.getElementById('projectCount').textContent=stats.projects.length;
  const maxP=Math.max(...stats.projects.map(p=>p.count),1);
  document.getElementById('projectBars').innerHTML=stats.projects.map(p=>
    '<div class="bar-row"><span class="bar-label">'+p.name+'</span><div class="bar-track"><div class="bar-fill proj" style="width:'+Math.max(p.count/maxP*100,8)+'%">'+p.count+'</div></div></div>'
  ).join('');

  // Category bars
  document.getElementById('categoryCount').textContent=stats.categories.length;
  const maxC=Math.max(...stats.categories.map(c=>c.count),1);
  document.getElementById('categoryBars').innerHTML=stats.categories.map(c=>
    '<div class="bar-row"><span class="bar-label">'+c.name+'</span><div class="bar-track"><div class="bar-fill cat" style="width:'+Math.max(c.count/maxC*100,8)+'%">'+c.count+'</div></div></div>'
  ).join('');

  // Fill project selects
  ['filterProject','newProject'].forEach(id=>{
    const sel=document.getElementById(id);
    const existing=sel.options[0];
    sel.innerHTML='';sel.appendChild(existing);
    stats.projects.forEach(p=>{const o=document.createElement('option');o.value=p.name;o.textContent=p.name+' ('+p.count+')';sel.appendChild(o)});
  });
}

async function loadMemories(){
  isSearchMode=false;currentPage=0;await fetchMemories();
}

async function fetchMemories(){
  const project=document.getElementById('filterProject').value;
  const category=document.getElementById('filterCategory').value;
  const importance=document.getElementById('filterImportance').value;
  const status=document.getElementById('filterStatus').value;
  const offset=currentPage*pageSize;

  let url='/api/memories?limit='+pageSize+'&offset='+offset+'&status='+status;
  if(project)url+='&project='+encodeURIComponent(project);
  if(category)url+='&category='+encodeURIComponent(category);
  if(importance)url+='&importance='+encodeURIComponent(importance);

  const data=await api(url);
  totalMemories=data.total;
  renderMemories(data.memories);
}

async function doSearch(){
  const q=document.getElementById('searchInput').value.trim();
  if(!q){loadMemories();return}
  isSearchMode=true;
  const project=document.getElementById('filterProject').value;
  const category=document.getElementById('filterCategory').value;
  let url='/api/search?q='+encodeURIComponent(q);
  if(project)url+='&project='+encodeURIComponent(project);
  if(category)url+='&category='+encodeURIComponent(category);

  const data=await api(url);
  totalMemories=data.results.length;
  renderMemories(data.results);
}

function renderMemories(memories){
  document.getElementById('memoryCount').textContent=totalMemories;
  const start=isSearchMode?1:currentPage*pageSize+1;
  const end=start+memories.length-1;
  document.getElementById('pageInfo').textContent=
    memories.length===0?'No memories found':'Showing '+start+'-'+end+' of '+totalMemories;
  document.getElementById('prevBtn').disabled=currentPage===0||isSearchMode;
  document.getElementById('nextBtn').disabled=isSearchMode||(currentPage+1)*pageSize>=totalMemories;

  document.getElementById('memoryBody').innerHTML=memories.map(m=>{
    const impClass='pill-'+(m.importance||'normal');
    const decay=typeof m.decay_score==='number'?m.decay_score:1;
    return '<tr onclick="showMemory('+m.id+')" style="cursor:pointer">'+
      '<td style="color:var(--text-muted);font-family:JetBrains Mono;font-size:12px">#'+m.id+'</td>'+
      '<td class="content-cell"><div class="content-preview">'+escapeHtml(m.content)+'</div></td>'+
      '<td>'+(m.project?'<span class="pill pill-proj">'+m.project+'</span>':'<span style="color:var(--text-muted)">—</span>')+'</td>'+
      '<td><span class="pill pill-cat">'+m.category+'</span></td>'+
      '<td><span class="pill '+impClass+'">'+(m.importance||'normal')+'</span></td>'+
      '<td><div class="decay-bar"><div class="decay-fill" style="width:'+(decay*100)+'%;background:'+decayColor(decay)+'"></div></div></td>'+
      '<td style="color:var(--text-dim);font-size:12px">'+(m.access_count??0)+'</td>'+
      '<td style="color:var(--text-muted);font-size:12px;white-space:nowrap">'+(m.created_at?timeSince(m.created_at):'—')+'</td>'+
      '<td><button class="action-btn danger" onclick="event.stopPropagation();forgetMemory('+m.id+')">forget</button></td>'+
    '</tr>'}).join('');
}

async function showMemory(id){
  const data=await api('/api/memories?status=all&limit=1&offset=0');
  // Fetch specific memory
  const allUrl='/api/search?q='+id;
  // Actually let's get it from the table
  const searchUrl='/api/memories?status=all&limit=200';
  const all=await api(searchUrl);
  const m=all.memories.find(x=>x.id===id);
  if(!m)return;

  document.getElementById('modalTitle').textContent='Memory #'+m.id;
  document.getElementById('modalMeta').innerHTML=
    '<div class="meta-item"><div class="meta-label">Project</div><div class="meta-value">'+(m.project||'Global')+'</div></div>'+
    '<div class="meta-item"><div class="meta-label">Category</div><div class="meta-value">'+m.category+'</div></div>'+
    '<div class="meta-item"><div class="meta-label">Importance</div><div class="meta-value">'+(m.importance||'normal')+'</div></div>'+
    '<div class="meta-item"><div class="meta-label">Decay Score</div><div class="meta-value">'+(typeof m.decay_score==='number'?(m.decay_score*100).toFixed(1)+'%':'100%')+'</div></div>'+
    '<div class="meta-item"><div class="meta-label">Access Count</div><div class="meta-value">'+(m.access_count??0)+'</div></div>'+
    '<div class="meta-item"><div class="meta-label">Status</div><div class="meta-value">'+(m.status||'active')+'</div></div>'+
    '<div class="meta-item"><div class="meta-label">Created</div><div class="meta-value">'+(m.created_at||'—')+'</div></div>'+
    '<div class="meta-item"><div class="meta-label">Tags</div><div class="meta-value">'+(m.tags||'[]')+'</div></div>';
  document.getElementById('modalContent').textContent=m.content;
  document.getElementById('modal').classList.add('active');
}

function closeModal(){document.getElementById('modal').classList.remove('active')}

async function forgetMemory(id){
  if(!confirm('Forget memory #'+id+'?'))return;
  const r=await apiPost('/api/forget',{id});
  toast(r.message||'Forgotten');
  loadStats();if(isSearchMode)doSearch();else fetchMemories();
}

async function addMemory(){
  const content=document.getElementById('newContent').value.trim();
  if(!content){toast('Content is required','error');return}
  const project=document.getElementById('newProject').value||undefined;
  const category=document.getElementById('newCategory').value;
  const importance=document.getElementById('newImportance').value;
  const tagsRaw=document.getElementById('newTags').value.trim();
  const tags=tagsRaw?tagsRaw.split(',').map(t=>t.trim()).filter(Boolean):[];

  const r=await apiPost('/api/remember',{content,project,category,importance,tags});
  toast(r.message||'Remembered!');
  document.getElementById('newContent').value='';
  document.getElementById('newTags').value='';
  loadStats();fetchMemories();
}

function toggleAddForm(){document.getElementById('addForm').classList.toggle('open')}
function prevPage(){if(currentPage>0){currentPage--;fetchMemories()}}
function nextPage(){if((currentPage+1)*pageSize<totalMemories){currentPage++;fetchMemories()}}
function escapeHtml(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}

// Init
loadStats();loadMemories();
// Auto-refresh stats every 30s
setInterval(loadStats,30000);
</script>
</body>
</html>`;
}

// ──────────────────────────────────────────────────
// HTTP Server
// ──────────────────────────────────────────────────

function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk.toString()));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
  });
}

async function main() {
  const db = await initDatabase();
  migrate(db);
  persistDb();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    // Dashboard
    if (path === "/" || path === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(dashboardHTML());
      return;
    }

    // API
    if (path.startsWith("/api/")) {
      try {
        const body = method === "POST" ? await parseBody(req) : {};
        const result = await handleApi(db, path, url.searchParams, method, body);
        if (result === null) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not found" }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        }
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(PORT, () => {
    console.log(`\n🧠 mcp-ai-brain Dashboard`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📍 http://localhost:${PORT}`);
    console.log(`💾 Database: ${resolveDbPath()}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
