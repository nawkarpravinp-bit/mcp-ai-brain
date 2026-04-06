# 🧠 mcp-ai-brain

> **Persistent memory for AI coding agents.** Local-first. Zero API costs. Works everywhere.

AI agents forget everything between sessions. **mcp-ai-brain** fixes that.

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that gives your AI agent a persistent, searchable, privacy-first memory — powered by SQLite, FTS5, and biological-inspired decay.

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🔍 **Hybrid Search** | Keyword (FTS5) + local vector embeddings via `all-MiniLM-L6-v2`, fused with RRF |
| 🧬 **Memory Decay** | Ebbinghaus-inspired forgetting curve — unused memories lose relevance, critical ones never fade |
| 📂 **Project Scoping** | Memories are scoped to projects — your web app context stays separate from your CLI tool context |
| 🔒 **Privacy-First** | Everything stays on your machine. No cloud. No API calls. Your `brain.db` never leaves `~/.mcp-ai-brain/` |
| ⚡ **Zero Cost** | No embeddings API needed. Runs `all-MiniLM-L6-v2` locally via `@xenova/transformers` (~25MB, downloads once) |
| 🤖 **Auto-Learning** | `brain_session_end` extracts facts automatically from your session summary. No manual `remember` calls needed |
| 🎯 **Proactive Context** | `brain_session_start_smart` detects your workspace and loads the right memories automatically |
| 🌐 **Dashboard** | Built-in web dashboard at `localhost:3333` — view, search, edit memories in real-time |
| 🔌 **Universal** | Works with Claude Desktop, Cursor, Windsurf, Cline, Antigravity, and any MCP-compatible tool |

---

## 🚀 Quick Start

### Install

```bash
npm install -g mcp-ai-brain
```

### Configure your AI tool

Add to your MCP config (e.g., `claude_desktop_config.json`, `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "brain": {
      "command": "mcp-ai-brain"
    }
  }
}
```

That's it. Your AI now has a brain. 🧠

---

## 🛠️ Tools

### `brain_remember`
Store a memory. Supports categorization, tagging, importance levels, and project scoping.

```
Categories: fact | decision | preference | architecture | bug | config | pattern | incident | workflow
Importance: critical (never decays) | high | normal | low
```

### `brain_recall`
Retrieve memories by project, category, or importance — without needing a search query.

### `brain_search`
Hybrid search using keyword matching (FTS5) + local vector embeddings (`all-MiniLM-L6-v2`). Results fused with Reciprocal Rank Fusion — semantic similarity works out of the box once the model downloads (~25MB, one-time).

### `brain_forget`
Soft-delete a memory. It's excluded from search but can be restored.

### `brain_session_start`
Start a session — loads top memories for your project, runs decay maintenance, and returns context.

### `brain_session_end`
End a session — records what happened and for how long.

### `brain_projects_*`
Manage the project registry (`list`, `upsert`, `get`, `delete`).

### `brain_stats`
Brain diagnostics — memory counts, category breakdown, database path, vector status.

---

## 🧬 How Decay Works

Memories follow a biological forgetting curve:

1. **Grace Period** (7 days): No decay. Fresh memories stay at full strength.
2. **Active Decay**: Score decreases based on importance weight and time since last access.
3. **Access Resets Clock**: Every time a memory is recalled or found in search, its decay resets.
4. **Critical = Permanent**: Set importance to `critical` and the memory never decays.
5. **Decayed ≠ Deleted**: Decayed memories can be restored with `brain_restore`.

---

## ⚙️ Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `BRAIN_DB_PATH` | `~/.mcp-ai-brain/brain.db` | Custom database file location |

---

## 🏗️ Architecture

```
┌─────────────────────────────────┐
│        AI Agent (Claude, etc.)  │
│          via MCP Protocol       │
└────────────┬────────────────────┘
             │ stdio
┌────────────▼────────────────────┐
│       mcp-ai-brain server       │
│  ┌──────────┐  ┌─────────────┐  │
│  │ FTS5     │  │ MiniLM-L6v2 │  │
│  │ (keyword)│  │ (local vec) │  │
│  └────┬─────┘  └──────┬──────┘  │
│       │    RRF Fusion  │        │
│       └───────┬────────┘        │
│         ┌─────▼──────┐          │
│         │  SQLite DB  │          │
│         │  brain.db   │          │
│         └────────────┘          │
│  ┌──────────────────────────┐   │
│  │  Decay Engine            │   │
│  │  (Ebbinghaus curve)      │   │
│  └──────────────────────────┘   │
│  ┌──────────────────────────┐   │
│  │  Auto-Learning (v1.1)    │   │
│  │  Session summary → facts │   │
│  └──────────────────────────┘   │
└─────────────────────────────────┘
```

---

## 📊 What Your AI Agent Should Remember

| Category | Example |
|----------|---------|
| `decision` | "We chose NextJS over Remix because of Vercel deployment simplicity" |
| `architecture` | "Auth flow: Firebase Auth → Custom Claims → Middleware guard" |
| `config` | "Cron schedule: */10 * * * * (every 10 min, Vercel 300s timeout)" |
| `bug` | "Safari iOS AudioContext requires user gesture — fixed with click handler" |
| `pattern` | "All Firestore writes use transactions for multi-tenant isolation" |
| `preference` | "User prefers dark mode UI with Inter font family" |
| `incident` | "2024-01-15: Stripe webhook double-firing caused duplicate charges" |

---

## 🗺️ Roadmap

- [x] v1.0 — Core memory + keyword search (FTS5) + Ebbinghaus decay engine
- [x] v1.1 — Local embeddings (`all-MiniLM-L6-v2` via `@xenova/transformers`) + Auto-Learning + Proactive Context + Web Dashboard
- [ ] v1.2 — Multi-agent support + relationship graph between memories
- [ ] v2.0 — Proactive suggestions + memory consolidation + export/import

---

## 🤝 Contributing

PRs welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## 📄 License

MIT — see [LICENSE](LICENSE).

---

---

## 🌍 Built With This

Real-world projects powered by `mcp-ai-brain` — demonstrating persistent AI memory in production:

| Project | What It Does |
|---------|-------------|
| 🎤 [Ace Your Interviews](https://aceyourinterviews.app) | AI-powered real-time voice mock interviews — the only tool that simulates a real phone screen |
| 📍 [GeoQuote.ai](https://geoquote.ai) | Instant contractor quoting platform — real-time pricing intelligence for homeowners |
| 🎄 [The Funny Christmas Shop](https://thefunnychristmas.shop) | Hilarious holiday t-shirts with AI-generated designs, updated daily |
| 📝 [ChairFull.org](https://chairfull.org) | Office chair reviews and buying guides — AI-researched, human-curated |
| 💰 [VaultNest.org](https://vaultnest.org) | Personal finance guides — savings, investing, and financial independence |
| 🚛 [FleetShield.org](https://fleetshield.org) | Commercial trucking insurance guides for fleet owners |
| ✈️ [DutyPilot.org](https://dutypilot.org) | Import duty and customs tariff guides for international shoppers |
| 📖 [ManualJPro.org](https://manualjpro.org) | Product manual library — user guides and instruction manuals |
| 🛒 [Should I Buy It](https://sibt.ca) | AI buying-intent analysis — know before you spend |

> Want your project listed here? Open a PR and add it to this table.

---

## 👤 About the Author

Built and maintained by **[Pravin Nawkar](https://github.com/nawkarpravinp-bit)** — a developer building AI-powered SaaS tools and content platforms.

---

<p align="center">
  <b>Built with ❤️ to give AI agents the memory they deserve.</b>
</p>
