import { useState, useCallback, useRef } from 'react';
import { Coordinator } from '@uwdata/mosaic-core';
import { ToolExecutor } from '../tools/toolExecutor';
import type { ToolCall, ToolResult } from '../tools/toolExecutor';

export interface Message {
    role: 'user' | 'assistant' | 'tool';
    content: string;
    toolCalls?: ToolCall[];
    toolResults?: ToolResult[];
    isToolExecution?: boolean;
}

export interface AgentState {
    messages: Message[];
    isLoading: boolean;
    isExecutingTools: boolean;
    currentStep: string;
    error: string | null;
    toolsExecuted: string[];
    highlightIds: number[] | null;  // IDs of points to highlight on the map from tool results
    savedCategories: Map<string, any[]>;  // Category-based memory: category name -> array of review objects
    analyzeClusterCache: ToolResult[];  // Cache of all analyze_cluster results across rounds
}

const INITIAL_MESSAGE: Message = {
    role: 'assistant',
    content: `Hello! I'm your AI Sommelier and Wine Data Analyst.

I can help you explore the wine reviews dataset by:

- **Searching** for wines with specific notes (blackberry, oak, tannins, etc.)
- **Analyzing** scores, price trends, and regional characteristics
- **Finding** examples of high-scoring or good value wines
- **Answering** questions about varietals and styles

Try asking: "Find me good value reds under $20" or "What are the common flavors in Tuscan wines?"`
};

/**
 * Custom hook for agentic chat with tool execution.
 * Implements the agent loop: LLM → tool calls → execute → LLM → response
 */
export function useAgentChat(coordinator: Coordinator | null) {
    const [state, setState] = useState<AgentState>({
        messages: [INITIAL_MESSAGE],
        isLoading: false,
        isExecutingTools: false,
        currentStep: '',
        error: null,
        toolsExecuted: [],
        highlightIds: null,
        savedCategories: new Map(),
        analyzeClusterCache: [] // Store all analyze_cluster results across rounds
    });

    const toolExecutorRef = useRef<ToolExecutor | null>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    const analyzeClusterCacheRef = useRef<ToolResult[]>([]);  // Sync cache for analyze_cluster results

    // Initialize tool executor when coordinator is available
    if (coordinator && !toolExecutorRef.current) {
        toolExecutorRef.current = new ToolExecutor(coordinator);
    }

    /**
     * Extract point IDs from tool results for map highlighting
     */
    const extractHighlightIds = (toolResults: ToolResult[]): number[] => {
        const ids: number[] = [];
        for (const result of toolResults) {
            if (result.result?.reviews && Array.isArray(result.result.reviews)) {
                // text_search, flexible_search, get_sample all return reviews with id field
                for (const review of result.result.reviews) {
                    if (typeof review.id === 'number') {
                        ids.push(review.id);
                    }
                }
            } else if (result.result?.rows && Array.isArray(result.result.rows)) {
                // sql_query returns rows - check for __row_index__ or identifier
                for (const row of result.result.rows) {
                    if (typeof row.__row_index__ === 'number') {
                        ids.push(row.__row_index__);
                    } else if (typeof row.identifier === 'number') {
                        ids.push(row.identifier);
                    }
                }
            }
        }
        return [...new Set(ids)]; // Remove duplicates
    };

    /**
     * Send a message and run the agent loop
     */
    const sendMessage = useCallback(async (userMessage: string, selectedPoints?: any[], selectionPredicate?: string | null) => {
        // Debug: Log what selectedPoints we receive
        console.log("[AgentChat] sendMessage called with selectedPoints:", selectedPoints?.length, "points");
        console.log("[AgentChat] Selection predicate:", selectionPredicate);
        if (selectedPoints && selectedPoints.length > 0) {
            console.log("[AgentChat] First point structure:", JSON.stringify(selectedPoints[0], null, 2));
        }

        if (!userMessage.trim() || state.isLoading) return;
        if (!toolExecutorRef.current) {
            setState(prev => ({
                ...prev,
                error: 'Database not ready. Please wait for initialization.'
            }));
            return;
        }

        // Add user message to chat
        const userMsg: Message = { role: 'user', content: userMessage };
        setState(prev => ({
            ...prev,
            messages: [...prev.messages, userMsg],
            isLoading: true,
            error: null,
            currentStep: 'Thinking...',
            toolsExecuted: []
        }));

        // Create abort controller for this request
        abortControllerRef.current = new AbortController();
        const signal = abortControllerRef.current.signal;

        try {
            // Build conversation history for the API
            let conversationMessages = state.messages
                .filter(m => m.role === 'user' || (m.role === 'assistant' && !m.isToolExecution))
                .map(m => ({ role: m.role, content: m.content }));

            // Add the new user message
            conversationMessages.push({ role: 'user', content: userMessage });

            // If user has selected points, build context from the pre-fetched data
            if (selectedPoints && selectedPoints.length > 0) {
                console.log("[AgentChat] Building context from selected points...");

                // Get total count (attached to array by App.tsx)
                const totalSelected = (selectedPoints as any).totalCount || selectedPoints.length;
                console.log("[AgentChat] Total selected:", totalSelected, "Available:", selectedPoints.length);

                // Token limit: ~25000 tokens ≈ 100000 characters (4 chars per token estimate)
                // Model has 256k context, so this leaves plenty of room for response + tool results
                const MAX_CONTEXT_CHARS = 100000;
                const HEADER_RESERVE = 1000; // Reserve for header/footer text

                // Build reviews list, adding reviews until we hit the token limit
                const reviewsFormatted: string[] = [];
                let totalChars = 0;
                let reviewsIncluded = 0;

                for (let i = 0; i < selectedPoints.length; i++) {
                    const p = selectedPoints[i];
                    // Updated to use points instead of Rating
                    const points = p.fields?.points ?? p.fields?.Rating ?? 'N/A'; 
                    const title = p.fields?.title ?? 'Unknown Wine';
                    const description = p.fields?.description ?? p.text ?? 'No description';

                    const reviewText = `[Review ${i + 1}] Points: ${points} | Title: ${title}\n${description}`;

                    // Check if adding this review would exceed the limit
                    if (totalChars + reviewText.length + 4 > MAX_CONTEXT_CHARS - HEADER_RESERVE) {
                        console.log("[AgentChat] Token limit reached at review", i + 1);
                        break;
                    }

                    reviewsFormatted.push(reviewText);
                    totalChars += reviewText.length + 4; // +4 for "\n\n" separator
                    reviewsIncluded++;
                }

                const reviewsList = reviewsFormatted.join('\n\n');

                // Calculate statistics from included reviews
                const includedPoints = selectedPoints.slice(0, reviewsIncluded);
                const scores = includedPoints
                    .map((p: any) => p.fields?.points ?? p.fields?.Rating)
                    .filter((r: any): r is number => typeof r === 'number');

                const avgScore = scores.length > 0
                    ? (scores.reduce((a: number, b: number) => a + b, 0) / scores.length).toFixed(1)
                    : 'N/A';

                const scoreCounts = scores.reduce((acc: Record<number, number>, r: number) => {
                    acc[r] = (acc[r] || 0) + 1;
                    return acc;
                }, {} as Record<number, number>);

                const distributionText = Object.entries(scoreCounts)
                    .sort(([a], [b]) => Number(b) - Number(a))
                    .slice(0, 10) // Only show top 10 most common scores to save space
                    .map(([score, count]) => `${score}: ${count}`)
                    .join(', ');

                const truncatedNote = reviewsIncluded < totalSelected
                    ? `(Showing ${reviewsIncluded} of ${totalSelected} selected reviews in context)`
                    : '';

                // Include the SQL predicate so LLM can query the full selection
                const predicateInfo = selectionPredicate
                    ? `\n**SQL Filter for Tools:** To query ALL ${totalSelected} selected reviews, add this WHERE clause: \`${selectionPredicate}\``
                    : '';

                const selectionContext = `
**IMPORTANT: The user has selected ${totalSelected} reviews on the visualization.**
They are asking about THIS SPECIFIC SUBSET, not the entire dataset.

**Selection Statistics:**
- Total selected: ${totalSelected} reviews
- Reviews shown below: ${reviewsIncluded}
- Average score (of shown): ${avgScore}
- Score distribution (of shown): ${distributionText || 'N/A'}
${truncatedNote}
${predicateInfo}

**Selected Reviews:**
${reviewsList}

---
**Instructions:**
1. Answer based on the selected reviews shown above
2. You CAN USE TOOLS (sql_query, text_search) to query the FULL selection of ${totalSelected} reviews:
   - For sql_query: Include the WHERE clause shown above to filter to selected reviews
   - Example: \`SELECT AVG(points) FROM reviews WHERE ${selectionPredicate || '[predicate]'}\`
3. USE tools when the user asks for:
   - Exact counts, averages, or statistics across all selected reviews
   - Keyword searches within the selection
   - Detailed breakdowns that need all ${totalSelected} reviews
4. The ${reviewsIncluded} reviews shown above are a representative sample for topic/theme analysis
`;

                // Prepend selection context to the user's message
                conversationMessages[conversationMessages.length - 1].content =
                    `${selectionContext}\n\nUser question: ${userMessage}`;

                console.log("[AgentChat] Selection context built with", reviewsIncluded, "reviews (~" + Math.round(totalChars / 4) + " tokens), total selected:", totalSelected);
            }

            const maxIterations = 30; // Agentic search allows for deeper exploration
            let iteration = 0;
            const allToolsExecuted: string[] = [];

            while (iteration < maxIterations) {
                iteration++;

                // Call the agent API
                setState(prev => ({
                    ...prev,
                    currentStep: iteration === 1 ? 'Thinking...' : `Processing step ${iteration}/${maxIterations}...`
                }));

                // If we're approaching the limit, hint the LLM to wrap up
                // Give agent 3 steps to respond (inject at step 27, 28, 29)
                let messagesToSend = conversationMessages;
                if (iteration >= maxIterations - 3) {
                    const stepsRemaining = maxIterations - iteration;
                    // Add a system hint to stop using tools and give final answer
                    messagesToSend = [
                        ...conversationMessages,
                        {
                            role: 'system',
                            content: `IMPORTANT: You are approaching the step limit (${stepsRemaining} step${stepsRemaining > 1 ? 's' : ''} remaining). Please finalize your findings and provide the final comprehensive answer now. Do NOT call any more tools unless absolutely critical.`
                        } as any
                    ];
                }

                const response = await fetch('/api/agent', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ messages: messagesToSend }),
                    signal
                });

                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    throw new Error(errorData.error || `Request failed: ${response.status}`);
                }

                const data = await response.json();

                // If the LLM wants to call tools
                if (data.type === 'tool_calls' && data.tool_calls && data.tool_calls.length > 0) {
                    setState(prev => ({
                        ...prev,
                        isExecutingTools: true,
                        currentStep: `Executing ${data.tool_calls.length} tool(s)...`
                    }));

                    // Execute each tool
                    const toolResults: ToolResult[] = [];
                    for (const toolCall of data.tool_calls) {
                        const toolName = toolCall.function?.name || 'unknown';
                        allToolsExecuted.push(toolName);

                        setState(prev => ({
                            ...prev,
                            currentStep: `Running: ${toolName}...`,
                            toolsExecuted: [...allToolsExecuted]
                        }));

                        const result = await toolExecutorRef.current!.execute(toolCall);
                        toolResults.push(result);

                        // Cache analyze_cluster results for later save_reviews calls
                        if (result.name === 'analyze_cluster' && result.result?.review_ids) {
                            analyzeClusterCacheRef.current.push(result);  // Sync update via ref
                            console.log(`[Agent] Cached analyze_cluster result, total cached:`, analyzeClusterCacheRef.current.length);
                        }

                        console.log(`[Agent] Tool ${toolName} result:`, result);
                    }

                    // Handle save_reviews tool: extract reviews from analyze_cluster results
                    for (const toolResult of toolResults) {
                        if (toolResult.name === 'save_reviews' && toolResult.result?.saved) {
                            const { review_ids, category } = toolResult.result;

                            // Find the most recent analyze_cluster result that contains these IDs
                            let categoryData: any = null;

                            console.log(`[Agent] Processing save_reviews for category: "${category}", review_ids:`, review_ids);
                            console.log(`[Agent] Current toolResults count:`, toolResults.length, toolResults.map(t => t.name));
                            console.log(`[Agent] analyzeClusterCacheRef count:`, analyzeClusterCacheRef.current.length);

                            // Check both current toolResults AND cached analyze_cluster results
                            const allAnalyzeResults = [
                                ...toolResults.filter(t => t.name === 'analyze_cluster'),
                                ...analyzeClusterCacheRef.current
                            ];

                            console.log(`[Agent] Total analyze_cluster results to check:`, allAnalyzeResults.length);

                            // Check all analyze_cluster results (current + cached)
                            for (const prevResult of allAnalyzeResults) {
                                if (prevResult.name === 'analyze_cluster' && prevResult.result?.review_ids) {
                                    const analyzerData = prevResult.result;
                                    const analyzerReviewIds = analyzerData.review_ids;

                                    console.log(`[Agent] Checking analyze_cluster result:`, {
                                        analyzer_category: analyzerData.category,
                                        has_reviews: !!analyzerData.reviews,
                                        review_count: analyzerData.reviews?.length
                                    });

                                    // If the analyzer result contains the reviews we want to save
                                    const matchingIds = review_ids.filter((id: number) =>
                                        analyzerReviewIds.includes(id)
                                    );

                                    if (matchingIds.length > 0) {
                                        console.log(`[Agent] Found ${matchingIds.length} matching IDs, creating categoryData`);
                                        // Extract full review data if available
                                        categoryData = {
                                            category: category, // Use the category from save_reviews call
                                            analyzer_category: analyzerData.category, // Keep original for reference
                                            sentiment: analyzerData.sentiment,
                                            themes: analyzerData.themes,
                                            quotes: analyzerData.quotes,
                                            avg_points: analyzerData.avg_points, // Updated from avg_rating
                                            review_ids: matchingIds,
                                            reviews: analyzerData.reviews || [], // Full reviews array from analyzer
                                            bin_x: analyzerData.bin_x,
                                            bin_y: analyzerData.bin_y,
                                            count: matchingIds.length
                                        };
                                        break;
                                    }
                                }
                            }

                            // Update savedCategories state
                            if (categoryData) {
                                setState(prev => ({
                                    ...prev,
                                    savedCategories: new Map(prev.savedCategories).set(
                                        category,
                                        [categoryData] // Store as array for consistency
                                    )
                                }));
                                console.log(`[Agent] Saved category "${category}" with ${categoryData.count} review(s)`);
                            } else {
                                console.warn(`[Agent] Failed to save category "${category}" - no matching analyze_cluster result found`);
                            }
                        }
                    }

                    // Extract IDs from tool results and update highlight
                    const newHighlightIds = extractHighlightIds(toolResults);
                    if (newHighlightIds.length > 0) {
                        console.log(`[Agent] Setting highlight for ${newHighlightIds.length} points from tool results`);
                        setState(prev => ({
                            ...prev,
                            highlightIds: newHighlightIds
                        }));
                    }

                    // Add the assistant's tool call message to the conversation
                    conversationMessages.push({
                        role: 'assistant',
                        content: '',
                        tool_calls: data.tool_calls
                    } as any);

                    // Add tool results to the conversation
                    for (const result of toolResults) {
                        conversationMessages.push({
                            role: 'tool',
                            content: JSON.stringify(result.result || result.error),
                            tool_call_id: result.call_id
                        } as any);
                    }

                    // Continue the loop to get the final response
                    continue;
                }

                // Final response from the agent
                const assistantMsg: Message = {
                    role: 'assistant',
                    content: data.content || 'I apologize, but I could not generate a response.',
                    toolResults: allToolsExecuted.length > 0 ?
                        allToolsExecuted.map(name => ({ name, call_id: '', result: {} })) : undefined
                };

                setState(prev => ({
                    ...prev,
                    messages: [...prev.messages, assistantMsg],
                    isLoading: false,
                    isExecutingTools: false,
                    currentStep: '',
                    toolsExecuted: allToolsExecuted
                }));

                return;
            }

            // If we hit max iterations, provide a summary of what was done
            const toolsSummary = allToolsExecuted.length > 0
                ? `Tools used: ${[...new Set(allToolsExecuted)].join(', ')}.`
                : '';
            throw new Error(`Analysis reached the limit of ${maxIterations} steps. ${toolsSummary} Please try a more specific question.`);

        } catch (error) {
            // Check if this was an abort
            if (error instanceof Error && error.name === 'AbortError') {
                console.log('[AgentChat] Request was cancelled by user');
                setState(prev => ({
                    ...prev,
                    isLoading: false,
                    isExecutingTools: false,
                    currentStep: '',
                    messages: [...prev.messages, {
                        role: 'assistant',
                        content: 'Request cancelled.'
                    }]
                }));
                return;
            }

            console.error('[AgentChat] Error:', error);
            const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';

            setState(prev => ({
                ...prev,
                isLoading: false,
                isExecutingTools: false,
                currentStep: '',
                error: errorMessage,
                messages: [...prev.messages, {
                    role: 'assistant',
                    content: `I encountered an error: ${errorMessage}\n\nPlease try again or rephrase your question.`
                }]
            }));
        } finally {
            abortControllerRef.current = null;
        }
    }, [state.messages, state.isLoading, coordinator]);

    /**
     * Clear chat history and highlight
     */
    const clearChat = useCallback(() => {
        setState({
            messages: [INITIAL_MESSAGE],
            isLoading: false,
            isExecutingTools: false,
            currentStep: '',
            error: null,
            toolsExecuted: [],
            highlightIds: null,
            savedCategories: new Map(),
            analyzeClusterCache: []
        });
        analyzeClusterCacheRef.current = [];  // Also clear the ref cache
    }, []);

    /**
     * Clear highlight without clearing chat
     */
    const clearHighlight = useCallback(() => {
        setState(prev => ({
            ...prev,
            highlightIds: null
        }));
    }, []);

    /**
     * Stop the current generation/thinking process
     */
    const stopGeneration = useCallback(() => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }
    }, []);

    return {
        ...state,
        sendMessage,
        clearChat,
        clearHighlight,
        stopGeneration
    };
}
