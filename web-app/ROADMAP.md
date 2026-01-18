# Atlas Analyst Roadmap

> LLM-powered data analyst for TripAdvisor Review Atlas

---

## ✅ Completed Phases

### Phase 1: Basic RAG Chat ✅

Context-aware chat using selected reviews with loading states and error handling.

### Phase 2: Agentic Tool Use ✅

LLM can call tools to query data with multi-step reasoning loop.

---

## Current Capabilities (v0.1)

### Agent Capabilities

The AI agent can analyze hotel reviews through natural language:

| Capability | Status | Description |
|------------|--------|-------------|
| SQL Queries | ✅ | Execute complex queries (aggregations, filters, grouping) |
| Text Search | ✅ | Find reviews by keywords or phrases |
| Statistics | ✅ | Get counts, averages, rating distributions |
| Sampling | ✅ | Retrieve example reviews for context |
| Summarization | ✅ | LLM synthesizes findings into natural language |

### Agent Tools

| Tool | What It Does | Example Query |
|------|--------------|---------------|
| `sql_query` | Run SELECT queries on DuckDB | *"How many 5-star reviews mention breakfast?"* |
| `text_search` | Case-insensitive keyword search | *"Find reviews about noisy rooms"* |
| `get_stats` | Rating distribution & averages | *"What's the overall sentiment?"* |
| `get_sample` | Random review samples (with filters) | *"Show me negative reviews"* |

**Security:** Only SELECT queries allowed. Results capped at 100 rows.

### Chat Features

- ✅ Floating "Ask AI" widget with glassmorphism design
- ✅ Map selection → LLM context (lasso/rectangle tools)
- ✅ Multi-step agent reasoning (up to 8 tool calls)
- ✅ Real-time tool execution feedback
- ✅ Markdown rendering in responses

### Architecture

```
User Selection (lasso/rect)
    → DuckDB query via predicate
    → Context passed to LLM (up to 500 reviews)
    → Agent calls tools as needed
    → Response rendered with Markdown
```

---

## 🎯 Next Up: Phase 3 — Agent → Map Selection

**Goal:** Highlight query results on the map

When the agent finds reviews (e.g., "all 1-star reviews mentioning 'dirty'"), those points should be visually selected on the Atlas.

**Research confirmed:**
- `selection` prop accepts `DataPointID[]` ✅
- Points render with colored circles + stroke overlay

**Implementation:**
- [ ] Add `agentSelection` state for query result IDs
- [ ] Tools return `__row_index__` with results
- [ ] "Show on map" button in chat
- [ ] Clear agent selection on new user selection

---

## 🚧 Planned Features

### Phase 4: Enhanced Search
- [ ] Semantic vector search (cosine similarity)
- [ ] Fuzzy/regex text matching
- [ ] Search highlighting on map

### Phase 5: Topic Navigation
> ⚠️ Blocked — waiting on Atlas API

- [ ] `get_topics` — list visible cluster labels
- [ ] `select_topic` — get documents in a cluster
- [ ] `drill_down` — explore sub-clusters

**Tracking:** [GitHub Issue #142](https://github.com/apple/embedding-atlas/issues/142)

### Phase 6: Advanced Analytics
- [ ] Comparative analysis tools
- [ ] Trend detection
- [ ] Export/report generation

### Phase 7: UI Polish
- [ ] Chat history persistence
- [ ] Multi-turn memory
- [ ] Suggested questions

---

## ⚠️ Known Issues

| Issue | Status | Notes |
|-------|--------|-------|
| Sidebar overflow | PR submitted | [#140](https://github.com/apple/embedding-atlas/pull/140) |
| Stylesheet prop broken | Investigating | Shadow DOM may block custom CSS |
| Topic labels not exposed | Feature requested | [#142](https://github.com/apple/embedding-atlas/issues/142) |

---

## 🔧 Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 19 + TypeScript + Vite |
| Visualization | embedding-atlas (Apple) |
| Data Engine | DuckDB-WASM + Mosaic |
| Backend | Vercel Serverless Functions |
| LLM | OpenRouter → nvidia/nemotron-3-nano |

---

## 📁 Project Structure

```
web-app/
├── api/
│   ├── chat.ts          # Basic chat endpoint
│   └── agent.ts         # Agent with tool calling
├── src/
│   ├── App.tsx          # Main component
│   ├── hooks/
│   │   └── useAgentChat.ts  # Agent loop logic
│   └── tools/
│       └── toolExecutor.ts  # DuckDB tool execution
├── vercel.json          # Deployment config
└── .env.local           # API keys (git-ignored)
```

---

## 🚀 Development

```bash
# Start dev server (required for API routes)
vercel dev

# Build for production
npm run build
```

---

## 📝 Notes

- **Context limit:** 100k chars (~25k tokens) per request
- **Max iterations:** 8 tool calls before forced stop
- **Model:** `nvidia/nemotron-3-nano-30b-a3b:free` via OpenRouter
