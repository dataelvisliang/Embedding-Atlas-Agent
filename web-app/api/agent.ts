import type { VercelRequest, VercelResponse } from '@vercel/node';

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

// Tool definitions matching the frontend ToolExecutor
const TOOLS = [
    {
        type: "function",
        function: {
            name: "sql_query",
            description: "Execute a SQL SELECT query on the hotel reviews table. The table 'reviews' has columns: __row_index__ (int), description (text - the review content), Rating (int 1-5), projection_x (float), projection_y (float), neighbors (json). Use this for aggregations, counts, filtering, and complex queries.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "SQL SELECT query to execute. Examples: 'SELECT Rating, COUNT(*) FROM reviews GROUP BY Rating', 'SELECT AVG(Rating) FROM reviews', 'SELECT COUNT(*) FROM reviews WHERE Rating >= 4'"
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
            description: "Search for reviews containing specific keywords or phrases. Use this to find reviews mentioning topics like 'breakfast', 'pool', 'noise', 'staff', 'clean', etc.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "Keyword or phrase to search for in review text"
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
            description: "Get overall statistics for the reviews dataset including total count, average rating, and rating distribution.",
            parameters: {
                type: "object",
                properties: {
                    include_rating_distribution: {
                        type: "boolean",
                        description: "Whether to include breakdown by star rating (1-5)"
                    }
                }
            }
        }
    },
    {
        type: "function",
        function: {
            name: "get_sample",
            description: "Get a random sample of reviews to understand the data. Useful for getting examples of reviews with specific ratings.",
            parameters: {
                type: "object",
                properties: {
                    count: {
                        type: "number",
                        description: "Number of sample reviews to retrieve (default: 5, max: 20)"
                    },
                    rating_filter: {
                        type: "number",
                        description: "Optional: only get reviews with this star rating (1-5)"
                    }
                }
            }
        }
    },
    {
        type: "function",
        function: {
            name: "flexible_search",
            description: "Search for reviews where MULTIPLE terms ALL appear in the SAME review. Default mode is AND - all terms must be present in each matching review. Supports regex patterns when regex=true (e.g., 'break(fast|fst)' for typos, 'Bali.*Villa' for flexible matching).",
            parameters: {
                type: "object",
                properties: {
                    terms: {
                        type: "array",
                        items: { type: "string" },
                        description: "Array of search terms that must ALL appear in matching reviews. Example: ['breakfast', 'Bali Villa']"
                    },
                    mode: {
                        type: "string",
                        enum: ["AND", "OR"],
                        description: "AND (default) = ALL terms must appear in the SAME review. OR = matches reviews with ANY term (use for synonyms only)."
                    },
                    limit: {
                        type: "number",
                        description: "Maximum results (default: 15, max: 50)"
                    },
                    regex: {
                        type: "boolean",
                        description: "If true, treat terms as regex patterns. Examples: 'break(fast|fst)' matches typos, 'Bali.*Villa' matches 'Bali Beach Villa'. Default: false"
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
            description: "Get the cluster topic labels currently visible on the Atlas map. These labels represent the main themes/topics of the reviews in each area of the visualization (e.g., 'amsterdam-museums-tram-hotel', 'breakfast-room-staff-clean'). Use this to understand what topics the user is looking at or to explore the map's content.",
            parameters: {
                type: "object",
                properties: {}
            }
        }
    }
];

const SYSTEM_PROMPT = `You are an AI data analyst assistant for exploring TripAdvisor hotel reviews.

You have access to a database of hotel reviews with the following schema:

TABLE: reviews
- __row_index__: Unique identifier (integer)
- description: Full review text (string)
- Rating: Star rating from 1-5 (integer)
- projection_x, projection_y: 2D coordinates for visualization (float)
- neighbors: Pre-computed similar reviews (json)

AVAILABLE TOOLS:
1. sql_query: Execute SQL SELECT queries for aggregations and analysis
2. text_search: Search reviews for a single keyword or phrase
3. flexible_search: Search for MULTIPLE terms with AND/OR logic (PREFERRED for multi-word queries)
4. get_stats: Get overall statistics and rating distribution
5. get_sample: Get sample reviews to understand the data
6. get_topics: Get cluster topic labels currently visible on the Atlas map

UNDERSTANDING CLUSTERS:
The Atlas visualization is an embedding map where reviews are positioned based on semantic similarity.
- Reviews that are CLOSE TOGETHER on the map share similar topics, themes, or language
- Each CLUSTER is a group of semantically related reviews (e.g., all reviews about "pool and beach" or "business travel")
- CLUSTER LABELS (like "amsterdam-museums-tram-hotel") are auto-generated keywords summarizing the common themes in that area
- When users select points in the same cluster, they're selecting reviews about the same general topic
- The get_topics tool retrieves currently visible cluster labels from the map

INSTRUCTIONS:
- Always use tools to gather data before answering questions
- For multi-word queries like "breakfast at Bali Villa", use flexible_search with terms=["breakfast", "Bali Villa"] and mode="AND"
- flexible_search returns individual term counts - use these to explain data availability
- For quantitative questions (counts, averages), use sql_query
- Use get_topics to see what clusters/themes are visible on the map
- For CLUSTER DENSITY ANALYSIS: Use sql_query with FLOOR(projection_x/bin_size) and FLOOR(projection_y/bin_size) to group points into spatial bins and find dense clusters. Smaller bin sizes (e.g., 0.5) = more granular, larger (e.g., 2.0) = broader clusters
- Show your reasoning and cite specific data
- Be concise but thorough

VISUALIZATION CAPABILITIES:
- When your tools return reviews with IDs, those points are AUTOMATICALLY HIGHLIGHTED on the Atlas map with orange circles
- This helps users visually locate the reviews you're discussing in the embedding space
- Include __row_index__ in SQL queries when you want results to be highlighted: SELECT __row_index__, ... FROM reviews
- You can tell users: "I've highlighted these reviews on the map" when your query returns specific reviews

EXAMPLES:
- "What about breakfast at Bali Villa?" → flexible_search({terms: ["breakfast", "Bali Villa"], mode: "AND"})
- "Reviews mentioning pool or beach" → flexible_search({terms: ["pool", "beach"], mode: "OR"})
- "What do people say about breakfast?" → text_search("breakfast")
- "What's the average rating?" → get_stats with include_rating_distribution=true
- "How many 5-star reviews?" → sql_query("SELECT COUNT(*) FROM reviews WHERE Rating = 5")
- "What topics are on the map?" → get_topics()
- "Find dense clusters" → sql_query("SELECT FLOOR(projection_x/1.0) as bin_x, FLOOR(projection_y/1.0) as bin_y, COUNT(*) as count, AVG(Rating) as avg_rating FROM reviews GROUP BY bin_x, bin_y HAVING count > 10 ORDER BY count DESC LIMIT 10")`;

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
                'X-Title': 'TripAdvisor Review Atlas Agent'
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
