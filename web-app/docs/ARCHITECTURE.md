# Atlas Analyst Architecture

This document provides a detailed technical overview of how the Atlas visualization widget works and how the AI agent integrates with it.

---

## System Overview

```mermaid
flowchart TB
    subgraph User["User Interaction"]
        Mouse["Mouse Events<br/>pan, zoom, select"]
        Keyboard["Keyboard<br/>search, shortcuts"]
        Chat["Chat Input<br/>natural language"]
    end

    subgraph Frontend["React Frontend (App.tsx)"]
        subgraph AtlasWidget["Embedding Atlas Widget"]
            Canvas["WebGL Canvas<br/>Point rendering"]
            Labels["Label Generation<br/>Cluster naming"]
            Selection["Selection Tools<br/>Lasso, Rectangle"]
            Sidebar["Info Sidebar<br/>Point details"]
        end
        
        subgraph ChatUI["Chat Widget"]
            Messages["Message List"]
            Input["Input Field"]
            Status["Tool Status Display"]
        end
        
        subgraph Hooks["React Hooks"]
            useAgentChat["useAgentChat<br/>Agent loop logic"]
            useState["State Management<br/>selection, messages"]
        end
    end

    subgraph DataLayer["In-Browser Data Layer"]
        DuckDB["DuckDB-WASM<br/>SQL engine"]
        Mosaic["Mosaic Coordinator<br/>Query routing"]
        Parquet["dataset.parquet<br/>20k+ reviews"]
    end

    subgraph ToolExec["Tool Executor"]
        sqlQuery["sql_query"]
        textSearch["text_search"]
        getStats["get_stats"]
        getSample["get_sample"]
    end

    subgraph Backend["Vercel Serverless"]
        AgentAPI["/api/agent<br/>Tool definitions"]
    end

    subgraph LLM["OpenRouter API"]
        Model["LLM Model<br/>nvidia/nemotron"]
    end

    Mouse --> AtlasWidget
    Keyboard --> AtlasWidget
    Chat --> ChatUI
    
    AtlasWidget -->|"onStateChange"| Hooks
    AtlasWidget -->|"predicate SQL"| Mosaic
    ChatUI --> useAgentChat
    
    Mosaic --> DuckDB
    DuckDB --> Parquet
    
    useAgentChat -->|"API request"| AgentAPI
    AgentAPI -->|"messages + tools"| Model
    Model -->|"tool_calls"| AgentAPI
    AgentAPI -->|"execute"| useAgentChat
    useAgentChat --> ToolExec
    ToolExec --> Mosaic
    Mosaic -->|"results"| ToolExec
    ToolExec -->|"tool results"| useAgentChat
    Model -->|"final response"| AgentAPI
    AgentAPI --> ChatUI
```

---

## Atlas Widget Internals

The `EmbeddingAtlas` component from Apple handles visualization and interaction.

```mermaid
flowchart LR
    subgraph Props["Component Props"]
        data["data: string<br/>Parquet URL"]
        selection["selection: DataPoint[]<br/>Highlighted points"]
        onStateChange["onStateChange(state)<br/>Selection callback"]
        onSelection["onSelection(points)<br/>Selected data callback"]
    end

    subgraph Internal["Internal State (Svelte)"]
        viewState["View State<br/>pan, zoom, bounds"]
        predicate["Predicate<br/>SQL WHERE clause"]
        clusterLabels["Cluster Labels<br/>(not exported)"]
        hoverPoint["Hover Point<br/>Current tooltip"]
    end

    subgraph Rendering["Rendering Pipeline"]
        WebGL["WebGL Context<br/>Point sprites"]
        SVG["SVG Overlay<br/>Selection circles"]
        DOM["DOM Layer<br/>Labels, UI"]
    end

    subgraph Workers["Web Workers"]
        Clustering["clustering.worker<br/>HDBSCAN labels"]
        Embedding["embedding.worker<br/>Position calc"]
        Search["search.worker<br/>Text index"]
    end

    Props --> Internal
    Internal --> Rendering
    Internal --> Workers
    Workers -->|"labels"| Internal
```

### Atlas State Object

When `onStateChange` fires, it provides:

```typescript
interface AtlasState {
  predicate: string | null;  // SQL WHERE clause for selection
  // e.g., "__row_index__ IN (1, 2, 3, ...)"
}
```

### Selection Flow

```mermaid
sequenceDiagram
    participant User
    participant Atlas
    participant React
    participant DuckDB
    participant Agent

    User->>Atlas: Draw lasso selection
    Atlas->>Atlas: Calculate point intersections
    Atlas->>React: onStateChange({ predicate: "..." })
    React->>DuckDB: SELECT * FROM reviews WHERE {predicate}
    DuckDB-->>React: Selected rows (DataPoint[])
    React->>React: setSelectedPoints(rows)
    React->>Agent: Context includes selected reviews
```

---

## Agent Architecture

### Agent Loop

```mermaid
flowchart TB
    Start([User sends message]) --> AddMsg[Add to message history]
    AddMsg --> API[POST /api/agent]
    API --> LLM{LLM Response}
    
    LLM -->|"tool_calls"| Execute[Execute Tools Locally]
    Execute --> Results[Collect Tool Results]
    Results --> API
    
    LLM -->|"content"| Display[Display Response]
    Display --> End([Done])
    
    subgraph Iteration["Iteration Limit"]
        Counter["Max 8 iterations<br/>Prevents infinite loops"]
    end
    
    Execute --> Counter
    Counter -->|"< 8"| API
    Counter -->|">= 8"| ForceEnd[Force final response]
    ForceEnd --> Display
```

### Tool Execution Detail

```mermaid
sequenceDiagram
    participant Hook as useAgentChat
    participant API as /api/agent
    participant LLM as OpenRouter
    participant Exec as ToolExecutor
    participant DB as DuckDB

    Hook->>API: { messages: [...] }
    API->>LLM: Forward with tool definitions
    LLM-->>API: tool_calls: [{ name: "sql_query", args: {...} }]
    API-->>Hook: { type: "tool_calls", tool_calls: [...] }
    
    loop For each tool call
        Hook->>Exec: execute(toolCall)
        Exec->>DB: SQL query via Coordinator
        DB-->>Exec: Query results
        Exec-->>Hook: { name, result, call_id }
    end
    
    Hook->>API: { messages: [...], toolResults: [...] }
    API->>LLM: Messages + Tool Results
    LLM-->>API: Final content response
    API-->>Hook: { type: "response", content: "..." }
    Hook->>Hook: Display in chat
```

---

## Tool Definitions

```mermaid
classDiagram
    class ToolExecutor {
        -coordinator: Coordinator
        +execute(toolCall): ToolResult
        -sqlQuery(query): Result
        -textSearch(term, limit): Result
        -getStats(includeDistribution): Result
        -getSample(count, rating): Result
    }

    class sql_query {
        +query: string
        Returns: columns, rows, row_count
        Security: SELECT only
    }

    class text_search {
        +query: string
        +limit: number = 10
        Returns: matches, reviews[]
    }

    class get_stats {
        +include_rating_distribution: boolean
        Returns: total, avg_rating, distribution[]
    }

    class get_sample {
        +count: number = 5
        +rating_filter: number?
        Returns: sample_size, reviews[]
    }

    ToolExecutor --> sql_query
    ToolExecutor --> text_search
    ToolExecutor --> get_stats
    ToolExecutor --> get_sample
```

---

## Data Flow

```mermaid
flowchart LR
    subgraph Source["Data Source"]
        Parquet["dataset.parquet<br/>~5MB, 20k rows"]
    end

    subgraph Load["Load Time"]
        Fetch["HTTP Fetch"]
        Parse["Parquet Parse"]
        Index["DuckDB Index"]
    end

    subgraph Runtime["Runtime Queries"]
        Select["User Selection<br/>predicate query"]
        Tool["Agent Tools<br/>sql_query, etc."]
        Render["Atlas Render<br/>viewport query"]
    end

    subgraph Schema["Table Schema: reviews"]
        direction TB
        col1["__row_index__: INT"]
        col2["description: VARCHAR"]
        col3["Rating: INT (1-5)"]
        col4["projection_x: FLOAT"]
        col5["projection_y: FLOAT"]
        col6["neighbors: JSON"]
    end

    Parquet --> Fetch --> Parse --> Index
    Index --> Select
    Index --> Tool
    Index --> Render
```

---

## API Endpoints

### POST /api/agent

```mermaid
sequenceDiagram
    participant Client
    participant Agent as /api/agent
    participant OpenRouter

    Client->>Agent: POST { messages, toolResults? }
    
    Agent->>Agent: Validate request
    Agent->>Agent: Build system prompt
    Agent->>Agent: Attach tool definitions
    
    Agent->>OpenRouter: Forward request
    OpenRouter-->>Agent: Response
    
    alt Tool Calls Requested
        Agent-->>Client: { type: "tool_calls", tool_calls: [...] }
    else Final Response
        Agent-->>Client: { type: "response", content: "..." }
    end
```

---

## Context Management

```mermaid
flowchart TB
    subgraph Selection["User Selection"]
        Points["Selected Points<br/>up to 500 reviews"]
    end

    subgraph Context["Context Building"]
        Extract["Extract text + ratings"]
        Format["Format as numbered list"]
        Stats["Calculate avg rating"]
    end

    subgraph Limits["Token Limits"]
        MaxChars["100,000 chars<br/>~25k tokens"]
        Truncate["Truncate if needed"]
    end

    subgraph System["System Message"]
        Role["You are an AI analyst..."]
        Reviews["Selected reviews context"]
        Tools["Available tools list"]
    end

    Points --> Extract --> Format --> Stats
    Format --> MaxChars --> Truncate
    Truncate --> Reviews
    Role --> System
    Reviews --> System
    Tools --> System
```

---

## File Structure

```
web-app/
├── api/
│   ├── chat.ts              # Simple chat endpoint (Phase 1)
│   └── agent.ts             # Agent with tools (Phase 2)
│
├── src/
│   ├── App.tsx              # Main component
│   ├── App.css              # Styles
│   │
│   ├── hooks/
│   │   └── useAgentChat.ts  # Agent loop logic
│   │
│   └── tools/
│       └── toolExecutor.ts  # DuckDB tool execution
│
├── docs/
│   ├── ARCHITECTURE.md      # This file
│   └── ROADMAP.md           # Feature roadmap
│
├── public/
│   └── data/
│       ├── dataset.parquet  # Review embeddings
│       └── metadata.json    # Schema info
│
└── vercel.json              # Deployment config
```

---

## Security Model

```mermaid
flowchart TB
    subgraph Client["Client (Browser)"]
        UI["User Interface"]
        Tools["Tool Executor"]
    end

    subgraph Server["Server (Vercel)"]
        API["API Endpoint"]
        Key["API Key<br/>(env variable)"]
    end

    subgraph External["External"]
        LLM["OpenRouter API"]
    end

    UI -->|"No secrets"| API
    API -->|"Authenticated"| LLM
    Key -.->|"Injected"| API
    
    Tools -->|"SELECT only"| DB[(DuckDB)]
    
    subgraph Protections["Security Measures"]
        p1["✓ API key server-side only"]
        p2["✓ SQL injection prevention"]
        p3["✓ Query result limits (100 rows)"]
        p4["✓ Iteration limits (8 max)"]
        p5["✓ Context size limits (100k chars)"]
    end
```

---

## Performance Considerations

| Component | Strategy |
|-----------|----------|
| Parquet Loading | Single fetch, browser cached |
| DuckDB Queries | In-memory, ~10-50ms per query |
| Atlas Rendering | WebGL, handles 100k+ points |
| LLM Latency | 1-3s per request (model dependent) |
| Tool Execution | Local, <100ms per tool |
