import { Coordinator } from '@uwdata/mosaic-core';

/**
 * Extract visible topic labels from the Atlas visualization's Shadow DOM.
 * Labels are rendered as text elements within the Shadow DOM of the embedding-atlas component.
 */
function extractTopicsFromDOM(): string[] {
    const labels: string[] = [];

    // Recursive function to traverse DOM including Shadow DOMs
    const findLabelsInRoot = (root: Document | ShadowRoot | Element): void => {
        // Use TreeWalker for efficient DOM traversal
        const walker = document.createTreeWalker(
            root as Node,
            NodeFilter.SHOW_ELEMENT,
            null
        );

        let node: Node | null = walker.currentNode;
        while (node) {
            const el = node as Element;

            // Check if this element has a Shadow DOM and recurse into it
            if (el.shadowRoot) {
                findLabelsInRoot(el.shadowRoot);
            }

            // Look for elements containing topic labels
            // Labels may be split across multiple <text> elements, so we check parent groups too
            if (el.textContent) {
                const text = el.textContent.trim();
                // Topic labels are hyphenated keywords like "amsterdam-museums-tram-hotel"
                // Must have at least 4 parts separated by hyphens and no trailing hyphen
                const parts = text.split('-').filter(p => p.length > 0);
                if (parts.length >= 4 && !text.endsWith('-') && !labels.includes(text)) {
                    // Validation: each part should be word-like (letters, apostrophes, some special chars)
                    // Allow unicode apostrophes: ' (39), ' (8217), ′ (8242)
                    const validParts = parts.every(p => p.length >= 2 && /^[\w''′]+$/u.test(p));
                    // Keep labels short, no special chars that indicate code/CSS
                    if (validParts && text.length < 60 && !/[{}()=<>:;,\n\r\t]/.test(text)) {
                        labels.push(text);
                    }
                }
            }

            node = walker.nextNode();
        }
    };

    // Start from document body
    findLabelsInRoot(document.body);

    return labels;
}

export interface ToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}

export interface ToolResult {
    name: string;
    call_id: string;
    result: any;
    error?: string;
}

/**
 * ToolExecutor runs tools in the browser using DuckDB-WASM via Mosaic Coordinator.
 * This enables the LLM to query the full reviews dataset directly.
 */
export class ToolExecutor {
    private coordinator: Coordinator;

    constructor(coordinator: Coordinator) {
        this.coordinator = coordinator;
    }

    /**
     * Execute a tool call and return the result
     */
    async execute(toolCall: ToolCall): Promise<ToolResult> {
        const { name, arguments: argsJson } = toolCall.function;

        let args: any;
        try {
            args = JSON.parse(argsJson);
        } catch (e) {
            return {
                name,
                call_id: toolCall.id,
                result: null,
                error: `Failed to parse arguments: ${argsJson}`
            };
        }

        try {
            switch (name) {
                case 'sql_query':
                    return await this.sqlQuery(toolCall.id, args.query);

                case 'text_search':
                    return await this.textSearch(toolCall.id, args.query, args.limit);

                case 'flexible_search':
                    return await this.flexibleSearch(toolCall.id, args.terms, args.mode, args.limit, args.regex);

                case 'get_stats':
                    return await this.getStats(toolCall.id, args.include_rating_distribution);

                case 'get_sample':
                    return await this.getSample(toolCall.id, args.count, args.rating_filter);

                case 'get_topics':
                    return this.getTopics(toolCall.id);

                case 'analyze_cluster':
                    return await this.analyzeCluster(toolCall.id, args.bin_x, args.bin_y, args.bin_size, args.sample_size);

                case 'save_reviews':
                    return this.saveReviews(toolCall.id, args.review_ids, args.category);

                default:
                    return {
                        name,
                        call_id: toolCall.id,
                        result: null,
                        error: `Unknown tool: ${name}`
                    };
            }
        } catch (error) {
            return {
                name,
                call_id: toolCall.id,
                result: null,
                error: error instanceof Error ? error.message : 'Tool execution failed'
            };
        }
    }

    /**
     * Execute a SQL SELECT query on the reviews table
     * Security: Only allows SELECT queries
     */
    private async sqlQuery(callId: string, query: string): Promise<ToolResult> {
        // Security: Only allow SELECT queries
        const normalized = query.trim().toUpperCase();
        if (!normalized.startsWith('SELECT')) {
            return {
                name: 'sql_query',
                call_id: callId,
                result: null,
                error: 'Only SELECT queries are allowed for security reasons'
            };
        }

        // Block dangerous keywords
        const dangerousKeywords = ['DROP', 'DELETE', 'INSERT', 'UPDATE', 'ALTER', 'CREATE', 'TRUNCATE'];
        for (const keyword of dangerousKeywords) {
            if (normalized.includes(keyword)) {
                return {
                    name: 'sql_query',
                    call_id: callId,
                    result: null,
                    error: `Query contains forbidden keyword: ${keyword}`
                };
            }
        }

        const result = await this.coordinator.query(query);
        const allRows = result.toArray();
        const rows = allRows.slice(0, 100); // Limit results to 100 rows

        return {
            name: 'sql_query',
            call_id: callId,
            result: {
                columns: rows.length > 0 ? Object.keys(rows[0]) : [],
                rows: rows,
                row_count: rows.length,
                total_matching: allRows.length,
                truncated: allRows.length > 100
            }
        };
    }

    /**
     * Search for reviews containing specific keywords
     */
    private async textSearch(
        callId: string,
        searchQuery: string,
        limit: number = 10
    ): Promise<ToolResult> {
        // Escape single quotes to prevent SQL injection
        const escapedQuery = searchQuery.replace(/'/g, "''");
        const safeLimit = Math.min(Math.max(1, limit || 10), 50);

        const sql = `
      SELECT __row_index__, points, description, title, price
      FROM reviews
      WHERE description ILIKE '%${escapedQuery}%'
      LIMIT ${safeLimit}
    `;

        const result = await this.coordinator.query(sql);
        const rows = result.toArray();

        // Get total count for context
        const countSql = `
      SELECT COUNT(*) as total
      FROM reviews  
      WHERE description ILIKE '%${escapedQuery}%'
    `;
        const countResult = await this.coordinator.query(countSql);
        const totalMatches = countResult.toArray()[0]?.total || 0;

        return {
            name: 'text_search',
            call_id: callId,
            result: {
                query: searchQuery,
                matches_returned: rows.length,
                total_matches: totalMatches,
                reviews: rows.map(r => ({
                    id: r.__row_index__,
                    points: r.points,
                    title: r.title,
                    price: r.price,
                    excerpt: r.description?.length > 300
                        ? r.description.substring(0, 300) + '...'
                        : r.description
                }))
            }
        };
    }

    /**
     * Get overall statistics about the reviews dataset
     */
    private async getStats(
        callId: string,
        includeDistribution: boolean = true
    ): Promise<ToolResult> {
        // Get basic stats
        const statsResult = await this.coordinator.query(
            'SELECT COUNT(*) as total, AVG(points) as avg_points, MIN(points) as min_points, MAX(points) as max_points, AVG(price) as avg_price FROM reviews'
        );
        const stats = statsResult.toArray()[0];

        let distribution = null;
        if (includeDistribution) {
            const distResult = await this.coordinator.query(
                'SELECT points, COUNT(*) as count FROM reviews GROUP BY points ORDER BY points'
            );
            distribution = distResult.toArray();
        }

        return {
            name: 'get_stats',
            call_id: callId,
            result: {
                total_reviews: Number(stats.total),
                average_points: Number(stats.avg_points).toFixed(2),
                min_points: stats.min_points,
                max_points: stats.max_points,
                average_price: stats.avg_price ? Number(stats.avg_price).toFixed(2) : 'N/A',
                points_distribution: distribution
            }
        };
    }

    /**
    * Get a sample of reviews, optionally filtered by points
    */
    private async getSample(
        callId: string,
        count: number = 5,
        min_points?: number,
        max_points?: number
    ): Promise<ToolResult> {
        const safeCount = Math.min(Math.max(1, count || 5), 20);

        let sql = 'SELECT __row_index__, points, description, title, price FROM reviews';
        const conditions: string[] = [];

        if (min_points !== undefined) conditions.push(`points >= ${Math.floor(min_points)}`);
        if (max_points !== undefined) conditions.push(`points <= ${Math.floor(max_points)}`);

        if (conditions.length > 0) {
            sql += ' WHERE ' + conditions.join(' AND ');
        }
        sql += ` ORDER BY RANDOM() LIMIT ${safeCount}`;

        const result = await this.coordinator.query(sql);
        const rows = result.toArray();

        return {
            name: 'get_sample',
            call_id: callId,
            result: {
                sample_size: rows.length,
                filter: conditions.length > 0 ? conditions.join(' AND ') : 'none',
                reviews: rows.map(r => ({
                    id: r.__row_index__,
                    points: r.points,
                    title: r.title,
                    price: r.price,
                    text: r.description
                }))
            }
        };
    }

    /**
     * Flexible multi-term search with AND/OR modes and optional regex support
     * Solves the problem of "breakfast Bali Villa" finding nothing because it's treated as one phrase
     */
    private async flexibleSearch(
        callId: string,
        terms: string[],
        mode: 'AND' | 'OR' = 'AND',
        limit: number = 15,
        regex: boolean = false
    ): Promise<ToolResult> {
        // Handle string input (in case LLM sends comma-separated string)
        let searchTerms: string[] = [];
        if (typeof terms === 'string') {
            // Split by comma, semicolon, or " AND " / " OR "
            searchTerms = (terms as string)
                .split(/[,;]|\s+AND\s+|\s+OR\s+/i)
                .map(t => t.trim())
                .filter(t => t.length > 0);
        } else if (Array.isArray(terms)) {
            searchTerms = terms.map(t => String(t).trim()).filter(t => t.length > 0);
        }

        if (searchTerms.length === 0) {
            return {
                name: 'flexible_search',
                call_id: callId,
                result: null,
                error: 'No search terms provided'
            };
        }

        const safeLimit = Math.min(Math.max(1, limit || 15), 50);

        // Build WHERE clause - use regex or ILIKE based on mode
        const conditions = searchTerms.map(term => {
            if (regex) {
                // Use regexp_matches for regex mode
                // Escape single quotes for SQL
                const escaped = term.replace(/'/g, "''");
                return `regexp_matches(description, '${escaped}', 'i')`;
            } else {
                // Use ILIKE for normal substring matching
                const escaped = term.replace(/'/g, "''");
                return `description ILIKE '%${escaped}%'`;
            }
        });

        const whereClause = conditions.join(mode === 'AND' ? ' AND ' : ' OR ');

        // Query with matching reviews
        const sql = `
            SELECT __row_index__, points, description, title, price
            FROM reviews
            WHERE ${whereClause}
            LIMIT ${safeLimit}
        `;

        let rows: any[] = [];
        let totalMatches = 0;

        try {
            const result = await this.coordinator.query(sql);
            rows = result.toArray();

            // Get total count
            const countSql = `
                SELECT COUNT(*) as total
                FROM reviews
                WHERE ${whereClause}
            `;
            const countResult = await this.coordinator.query(countSql);
            totalMatches = Number(countResult.toArray()[0]?.total || 0);
        } catch (error) {
            // If regex is invalid, return helpful error
            if (regex && error instanceof Error) {
                return {
                    name: 'flexible_search',
                    call_id: callId,
                    result: null,
                    error: `Invalid regex pattern: ${error.message}`
                };
            }
            throw error;
        }

        // Also get individual term counts for context
        const termCounts: { term: string; count: number }[] = [];
        for (const term of searchTerms) {
            try {
                let termCountSql: string;
                if (regex) {
                    const escaped = term.replace(/'/g, "''");
                    termCountSql = `SELECT COUNT(*) as cnt FROM reviews WHERE regexp_matches(description, '${escaped}', 'i')`;
                } else {
                    const escaped = term.replace(/'/g, "''");
                    termCountSql = `SELECT COUNT(*) as cnt FROM reviews WHERE description ILIKE '%${escaped}%'`;
                }
                const termCountResult = await this.coordinator.query(termCountSql);
                termCounts.push({
                    term,
                    count: Number(termCountResult.toArray()[0]?.cnt || 0)
                });
            } catch {
                termCounts.push({ term, count: -1 }); // -1 indicates error
            }
        }

        return {
            name: 'flexible_search',
            call_id: callId,
            result: {
                terms: searchTerms,
                mode: mode,
                regex: regex,
                total_matches: totalMatches,
                matches_returned: rows.length,
                term_breakdown: termCounts,
                reviews: rows.map(r => ({
                    id: r.__row_index__,
                    points: r.points,
                    title: r.title,
                    price: r.price,
                    excerpt: r.description?.length > 300
                        ? r.description.substring(0, 300) + '...'
                        : r.description
                }))
            }
        };
    }

    /**
     * Get visible topic labels from the Atlas visualization
     * Extracts labels from the Shadow DOM of the embedding-atlas component
     */
    private getTopics(callId: string): ToolResult {
        try {
            const labels = extractTopicsFromDOM();

            if (labels.length === 0) {
                return {
                    name: 'get_topics',
                    call_id: callId,
                    result: {
                        topics: [],
                        count: 0,
                        note: 'No topic labels found. The Atlas may still be generating labels or the view may be too zoomed in/out.'
                    }
                };
            }

            return {
                name: 'get_topics',
                call_id: callId,
                result: {
                    topics: labels,
                    count: labels.length,
                    note: 'These are the cluster topic labels currently visible on the Atlas map. Labels change based on zoom level and viewport position.'
                }
            };
        } catch (error) {
            return {
                name: 'get_topics',
                call_id: callId,
                result: null,
                error: error instanceof Error ? error.message : 'Failed to extract topics from DOM'
            };
        }
    }

    /**
     * Analyze a cluster by delegating to the Analyzer Agent
     * Fetches reviews from the specified bin and sends them to /api/analyzer for analysis
     */
    private async analyzeCluster(
        callId: string,
        bin_x: number,
        bin_y: number,
        bin_size: number = 1.0,
        sample_size: number = 10
    ): Promise<ToolResult> {
        const safeSize = Math.min(Math.max(1, sample_size || 10), 80);

        // Fetch reviews from the specified bin
        const sql = `
            SELECT __row_index__, points, description, title, price
            FROM reviews
            WHERE FLOOR(projection_x/${bin_size}) = ${Math.floor(bin_x)}
              AND FLOOR(projection_y/${bin_size}) = ${Math.floor(bin_y)}
            LIMIT ${safeSize}
        `;

        let reviews: any[] = [];
        try {
            const result = await this.coordinator.query(sql);
            const rows = result.toArray();
            reviews = rows.map(r => ({
                id: r.__row_index__,
                points: r.points,
                title: r.title,
                text: r.description
            }));
        } catch (error) {
            return {
                name: 'analyze_cluster',
                call_id: callId,
                result: null,
                error: `Failed to fetch reviews from cluster: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }

        if (reviews.length === 0) {
            return {
                name: 'analyze_cluster',
                call_id: callId,
                result: {
                    category: 'Empty Cluster',
                    sentiment: 'N/A',
                    themes: [],
                    quotes: [],
                    count: 0,
                    avg_points: 0,
                    review_ids: [],
                    bin_x,
                    bin_y
                }
            };
        }

        // Call the Analyzer Agent API
        try {
            const response = await fetch('/api/analyzer', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    bin_x,
                    bin_y,
                    bin_size,
                    reviews
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Analyzer API returned ${response.status}: ${errorText}`);
            }

            const analysisResult = await response.json();

            return {
                name: 'analyze_cluster',
                call_id: callId,
                result: {
                    ...analysisResult,
                    reviews  // Attach the full reviews array for save_reviews to use
                }
            };
        } catch (error) {
            return {
                name: 'analyze_cluster',
                call_id: callId,
                result: null,
                error: `Analyzer Agent failed: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    /**
     * Save reviews to client-side memory for later reference
     * This is a lightweight operation that just returns a confirmation
     * The actual storage is handled by useAgentChat.ts
     */
    private saveReviews(
        callId: string,
        review_ids: number[],
        category: string
    ): ToolResult {
        return {
            name: 'save_reviews',
            call_id: callId,
            result: {
                saved: true,
                count: review_ids.length,
                category,
                review_ids
            }
        };
    }
}

/**
 * Tool definitions for the LLM (OpenAI function calling format)
 */
export const TOOL_DEFINITIONS = [
    {
        type: "function" as const,
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
        type: "function" as const,
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
        type: "function" as const,
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
        type: "function" as const,
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
        type: "function" as const,
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
        type: "function" as const,
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
        type: "function" as const,
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
        type: "function" as const,
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
