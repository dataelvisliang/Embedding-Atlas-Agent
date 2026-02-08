import type { VercelRequest, VercelResponse } from '@vercel/node';

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

// Tool definitions matching the frontend ToolExecutor
const TOOLS = [
    {
        type: "function",
        function: {
            name: "sql_query",
            description: "Execute a SQL SELECT query on the wine reviews table. The table 'reviews' has columns: __row_index__ (int), description (text), points (int 80-100 - score), price (float - cost), title (text - wine name), variety (text - grape), winery (text), country (text), province (text), region_1 (text), projection_x (float), projection_y (float), neighbors (json). Use this for aggregations, counts, filtering, and complex queries.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "SQL SELECT query to execute. Examples: 'SELECT points, COUNT(*) FROM reviews GROUP BY points', 'SELECT AVG(price) FROM reviews WHERE country = ''France''', 'SELECT * FROM reviews WHERE variety = ''Pinot Noir'' AND points >= 95'"
                    }
                },
                required: ["query"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "text_search",
            description: "Search for wine reviews containing specific keywords or phrases. Use this to find wines with specific notes like 'blackberry', 'oak', 'citrus', 'leather', 'tannins', etc.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "Keyword or phrase to search for in review description"
                    },
                    limit: {
                        type: "number",
                        description: "Maximum number of results to return (default: 10, max: 50)"
                    }
                },
                required: ["query"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "get_stats",
            description: "Get overall statistics for the wine dataset including total count, average points, and price distribution.",
            parameters: {
                type: "object",
                properties: {
                    include_points_distribution: {
                        type: "boolean",
                        description: "Whether to include breakdown by points (80-100)"
                    }
                }
            }
        }
    },
    {
        type: "function",
        function: {
            name: "get_sample",
            description: "Get a random sample of reviews to understand the data. Useful for getting examples of wines with specific scores.",
            parameters: {
                type: "object",
                properties: {
                    count: {
                        type: "number",
                        description: "Number of sample reviews to retrieve (default: 5, max: 20)"
                    },
                    min_points: {
                        type: "number",
                        description: "Optional: minimum score (80-100)"
                    },
                    max_points: {
                        type: "number",
                        description: "Optional: maximum score (80-100)"
                    }
                }
            }
        }
    },
    {
        type: "function",
        function: {
            name: "flexible_search",
            description: "Search for reviews where MULTIPLE terms ALL appear in the SAME review. Default mode is AND - all terms must be present. Supports regex patterns when regex=true (e.g., 'berr(y|ies)' for plurals, 'Napa.*Cab' for flexible matching).",
            parameters: {
                type: "object",
                properties: {
                    terms: {
                        type: "array",
                        items: { type: "string" },
                        description: "Array of search terms that must ALL appear in matching reviews. Example: ['blackberry', 'tannins', 'California']"
                    },
                    mode: {
                        type: "string",
                        enum: ["AND", "OR"],
                        description: "AND (default) = ALL terms must appear in the SAME review. OR = matches reviews with ANY term."
                    },
                    limit: {
                        type: "number",
                        description: "Maximum results (default: 15, max: 50)"
                    },
                    regex: {
                        type: "boolean",
                        description: "If true, treat terms as regex patterns. Default: false"
                    }
                },
                required: ["terms"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "get_topics",
            description: "Get the cluster topic labels currently visible on the Atlas map. These labels represent the main styles/varietals/regions in each area of the visualization (e.g., 'fruity-rosé-provence', 'bold-tannins-cabernet'). Use this to understand what wines the user is looking at.",
            parameters: {
                type: "object",
                properties: {}
            }
        }
    },
    {
        type: "function",
        function: {
            name: "analyze_cluster",
            description: "Delegate cluster analysis to a specialized Analyzer Agent. Provide coordinates of a dense cluster (bin_x, bin_y) and optionally the number of reviews to sample. The Analyzer will fetch reviews, analyze them, and return a lightweight summary containing: category label (e.g., 'Earthy Tuscan Reds'), sentiment/quality, flavor notes, and representative quotes. This tool does NOT consume your context window - only the summary is returned.",
            parameters: {
                type: "object",
                properties: {
                    bin_x: {
                        type: "number",
                        description: "X coordinate of the cluster bin (from FLOOR(projection_x/bin_size))"
                    },
                    bin_y: {
                        type: "number",
                        description: "Y coordinate of the cluster bin (from FLOOR(projection_y/bin_size))"
                    },
                    bin_size: {
                        type: "number",
                        description: "Size of the bin (default: 1.0). Match the bin_size used in your dense cluster query."
                    },
                    sample_size: {
                        type: "number",
                        description: "Number of reviews to analyze (default: 10, max: 80). Increase this when the user explicitly requests more samples."
                    }
                },
                required: ["bin_x", "bin_y"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "save_reviews",
            description: "Save a collection of verified reviews under a category label for the final answer. Use this AFTER you have confirmed (via analyze_cluster or other tools) that the wines are relevant to the user's query. The reviews will be displayed as category cards in the UI when you reference them as {{CATEGORY_NAME}}.",
            parameters: {
                type: "object",
                properties: {
                    review_ids: {
                        type: "array",
                        items: { type: "number" },
                        description: "Array of review IDs (__row_index__) to save"
                    },
                    category: {
                        type: "string",
                        description: "Category label (e.g., 'Budget-Friendly Whites', 'High-Scoring Bordeaux')"
                    }
                },
                required: ["review_ids", "category"]
            }
        }
    }
];

const SYSTEM_PROMPT = `You are the **Wine Expert Agent** (Sommelier AI) for exploring a massive database of wine reviews.
You are capable of autonomous data traversal, strategic planning, and pattern discovery on a 2D semantic map of wines.

TABLE: reviews
- __row_index__: Unique identifier (int)
- description: Review text
- points: 80-100 (int) - The wine's score (80-84: Good, 85-89: Very Good, 90-94: Outstanding, 95-100: Classic)
- price: Cost in USD (float)
- title: Wine name (text)
- variety: Grape variety (e.g., Pinot Noir, Chardonnay)
- winery: Winery name
- country: Country of origin
- province: Province/State
- projection_x, projection_y: 2D coordinates (float)
- neighbors: (json)

MULTI-AGENT ARCHITECTURE:
You are the **strategic decision-maker**. You do NOT read raw review text yourself.
Instead, you delegate analysis to a specialized **Analyzer Agent** using the \`analyze_cluster\` tool.

AGENTIC SEARCH PARADIGM:
Your workflow for complex queries:
1. **GLOBAL SCAN**: Find dense clusters or potential regions of interest using SQL:
   \`SELECT FLOOR(projection_x/1.0) as bin_x, FLOOR(projection_y/1.0) as bin_y, COUNT(*) as c FROM reviews GROUP BY bin_x, bin_y ORDER BY c DESC LIMIT 10\`
   (Or filter by WHERE clause if user asks for specific country/variety)
2. **TRAVERSAL LOOP**:
   a. **Pick a Cluster**: Select a dense cluster from your scan results.
   b. **Delegate Analysis**: Call \`analyze_cluster(bin_x, bin_y)\` to get a summary from the Analyzer Agent.
   c. **Evaluate Relevance**: Does the Analyzer's summary match the user's query?
   d. **Save if Relevant**: If yes, call \`save_reviews(review_ids, category)\` to bookmark those wines.
   e. **Move to Next**: Repeat for other clusters until you have comprehensive coverage.
3. **FINAL ANSWER**: Synthesize findings. Reference saved categories using {{CATEGORY}} syntax.

AVAILABLE TOOLS:
- \`sql_query\`: For dense cluster scanning, aggregations, counts, price filtering
- \`analyze_cluster\`: **PREFERRED** for exploring cluster content (delegates to Sub-Agent, lightweight)
  - Default: analyzes 10 reviews per cluster
  - **User preference**: If user asks for specific sample sizes (e.g., "20 samples", "50 examples"), pass the number via \`sample_size\` parameter
  - Max: 80 reviews per cluster
- \`save_reviews\`: Bookmark verified reviews under a category label
- \`text_search\`, \`flexible_search\`: For targeted keyword searches
- \`get_sample\`, \`get_stats\`, \`get_topics\`: For quick overviews

CRITICAL RULES:
1. **NEVER use sql_query to fetch wine samples or examples**
   - sql_query is ONLY for: finding clusters, counting, aggregations, filtering by metadata
   - ❌ WRONG: "SELECT title, points, description FROM reviews WHERE variety='Pinot Noir' LIMIT 5"
   - ✅ CORRECT: Use analyze_cluster to get wine samples from a cluster
   - **When user asks for wine examples**: Find relevant clusters → analyze_cluster → save_reviews
2. **Use analyze_cluster to inspect cluster content**
   - analyze_cluster returns full review descriptions without bloating your context
   - It includes: category, quality perception, flavor notes, quotes, review_ids, AND full reviews array
3. **MANDATORY: Use save_reviews to bookmark findings**
   - You MUST call \`save_reviews(review_ids, category)\` for EVERY category you want to present
   - The category parameter becomes the lookup key for the UI
   - Example: save_reviews([123, 456, 789], "Classic Sangiovese")
4. **Reference saved categories in your answer using {{CATEGORY}} syntax**
   - ONLY use {{}} placeholders for categories you have already saved
   - Example: "I found classic profiles {{Classic Sangiovese}} and modern blends {{Super Tuscans}}"
   - The UI will automatically expand these into rich, interactive review cards
5. **NEVER use brackets [Category: ...] format** - this will NOT render properly
6. **Do NOT output raw review text or individual IDs** - only category placeholders

⚠️ WARNING: If you write {{Category}} without calling save_reviews first, the UI will show broken "[Category: ...]" text instead of rich wine sample cards!

STEP-BY-STEP WORKFLOW:
For each category you want to present to the user:
Step 1: Call analyze_cluster to get summary + review_ids
Step 2: Call save_reviews(review_ids, "Your Category Name") ← REQUIRED! Do not skip!
Step 3: Include {{Your Category Name}} in your final answer

OUTPUT FORMAT EXAMPLE:
"Based on my analysis of Tuscan wines:

**Classic Sangiovese** {{Classic Sangiovese}} 
offers perfumed red fruits with leather and truffle notes.

**Super Tuscans** {{Super Tuscans}}
display darker fruits with cedar and chocolate.

[Your conclusion]"

CRITICAL: The text inside {{}} must EXACTLY match the category name you used in save_reviews.
Example: save_reviews([...], "Light & Fruity") → use {{Light & Fruity}} in your answer

If you forget to call save_reviews, the {{}} placeholders will show as "[Category: ...]" which looks broken to the user.

EXAMPLES:
- **Query**: "Find me good value reds under $20"
  **Workflow**:
  1. sql_query: \`SELECT ... FROM reviews WHERE price < 20 AND points >= 87 ...\` (checking clusters)
  2. analyze_cluster(...) → Returns: {category: "Portuguese Blends", sentiment: "Positive", ...}
  3. save_reviews(..., "Portuguese Blends")
  4. analyze_cluster(...) → Returns: {category: "Argentine Malbec", sentiment: "Positive", ...}
  5. save_reviews(..., "Argentine Malbec")
  6. **Answer**: "I found great options in {{Portuguese Blends}} using indigenous grapes, and robust {{Argentine Malbec}}."

Remember: You have ~30 steps. Use analyze_cluster to efficiently explore without consuming your context.`;

interface AgentMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_calls?: any[];
    tool_call_id?: string;
}

interface AgentRequest {
    messages: AgentMessage[];
    toolResults?: Array<{
        call_id: string;
        name: string;
        result: any;
    }>;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    const model = process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-nano-30b-a3b:free';

    if (!apiKey) {
        return res.status(500).json({ error: 'OpenRouter API key not configured' });
    }

    try {
        const { messages, toolResults }: AgentRequest = req.body;

        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: 'Invalid request: messages array required' });
        }

        // Build the message array for OpenRouter
        const apiMessages: AgentMessage[] = [
            { role: 'system', content: SYSTEM_PROMPT },
            ...messages
        ];

        // If we have tool results, add them as tool response messages
        if (toolResults && toolResults.length > 0) {
            for (const result of toolResults) {
                apiMessages.push({
                    role: 'tool',
                    content: JSON.stringify(result.result),
                    tool_call_id: result.call_id
                });
            }
        }

        console.log(`[Agent] Sending ${apiMessages.length} messages to ${model}`);

        const response = await fetch(OPENROUTER_API_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': req.headers.referer as string || req.headers.origin as string || 'https://localhost',
                'X-Title': 'Wine Review Atlas Agent'
            },
            body: JSON.stringify({
                model,
                messages: apiMessages,
                tools: TOOLS,
                tool_choice: 'auto'
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('[Agent] OpenRouter error:', response.status, errorText);

            // Try to parse the error message from OpenRouter
            let errorMessage = response.statusText;
            try {
                const errorData = JSON.parse(errorText);
                if (errorData.error?.message) {
                    errorMessage = errorData.error.message;
                }
            } catch {
                // If parsing fails, use the raw text if available
                if (errorText && errorText.length < 200) {
                    errorMessage = errorText;
                }
            }

            return res.status(response.status).json({
                error: `OpenRouter API error: ${errorMessage}`
            });
        }

        const data = await response.json();
        const choice = data.choices?.[0];

        if (!choice?.message) {
            return res.status(500).json({ error: 'No response from LLM' });
        }

        // Check if the LLM wants to call tools
        if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
            console.log(`[Agent] LLM requested ${choice.message.tool_calls.length} tool calls`);
            return res.status(200).json({
                type: 'tool_calls',
                tool_calls: choice.message.tool_calls,
                message: choice.message
            });
        }

        // Final text response
        console.log('[Agent] Returning final response');
        return res.status(200).json({
            type: 'response',
            content: choice.message.content || 'No response generated',
            model: data.model
        });

    } catch (error) {
        console.error('[Agent] Error:', error);
        return res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error'
        });
    }
}
