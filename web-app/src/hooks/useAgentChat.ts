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
}

const INITIAL_MESSAGE: Message = {
    role: 'assistant',
    content: `Hello! I'm your AI data analyst for TripAdvisor reviews. 

I can help you explore the dataset by:
• **Searching** for reviews mentioning specific topics (breakfast, pool, noise, etc.)
• **Analyzing** ratings, distributions, and trends
• **Finding** examples of positive or negative reviews
• **Answering** questions about the data

Try asking: "What's the rating distribution?" or "What do people say about breakfast?"`
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
        toolsExecuted: []
    });

    const toolExecutorRef = useRef<ToolExecutor | null>(null);

    // Initialize tool executor when coordinator is available
    if (coordinator && !toolExecutorRef.current) {
        toolExecutorRef.current = new ToolExecutor(coordinator);
    }

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
                    const rating = p.fields?.Rating ?? 'N/A';
                    const description = p.fields?.description ?? p.text ?? 'No description';

                    const reviewText = `[Review ${i + 1}] Rating: ${rating}★\n${description}`;

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
                const ratings = includedPoints
                    .map((p: any) => p.fields?.Rating)
                    .filter((r: any): r is number => typeof r === 'number');

                const avgRating = ratings.length > 0
                    ? (ratings.reduce((a: number, b: number) => a + b, 0) / ratings.length).toFixed(2)
                    : 'N/A';

                const ratingCounts = ratings.reduce((acc: Record<number, number>, r: number) => {
                    acc[r] = (acc[r] || 0) + 1;
                    return acc;
                }, {} as Record<number, number>);

                const distributionText = Object.entries(ratingCounts)
                    .sort(([a], [b]) => Number(b) - Number(a))
                    .map(([rating, count]) => `${rating}★: ${count}`)
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
- Average rating (of shown): ${avgRating}★
- Rating distribution (of shown): ${distributionText || 'N/A'}
${truncatedNote}
${predicateInfo}

**Selected Reviews:**
${reviewsList}

---
**Instructions:**
1. Answer based on the selected reviews shown above
2. You CAN USE TOOLS (sql_query, text_search) to query the FULL selection of ${totalSelected} reviews:
   - For sql_query: Include the WHERE clause shown above to filter to selected reviews
   - Example: \`SELECT AVG(Rating) FROM reviews WHERE ${selectionPredicate || '[predicate]'}\`
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

            const maxIterations = 8; // Prevent infinite loops
            let iteration = 0;
            const allToolsExecuted: string[] = [];

            while (iteration < maxIterations) {
                iteration++;

                // Call the agent API
                setState(prev => ({
                    ...prev,
                    currentStep: iteration === 1 ? 'Thinking...' : `Processing... (step ${iteration})`
                }));

                // If we're on the last iteration, hint the LLM to wrap up
                let messagesToSend = conversationMessages;
                if (iteration === maxIterations - 1) {
                    // Add a system hint to stop using tools and give final answer
                    messagesToSend = [
                        ...conversationMessages,
                        {
                            role: 'system',
                            content: 'IMPORTANT: You have used enough tools. Please provide your final answer now based on the information gathered. Do NOT call any more tools.'
                        } as any
                    ];
                }

                const response = await fetch('/api/agent', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ messages: messagesToSend })
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

                        console.log(`[Agent] Tool ${toolName} result:`, result);
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
        }
    }, [state.messages, state.isLoading, coordinator]);

    /**
     * Clear chat history
     */
    const clearChat = useCallback(() => {
        setState({
            messages: [INITIAL_MESSAGE],
            isLoading: false,
            isExecutingTools: false,
            currentStep: '',
            error: null,
            toolsExecuted: []
        });
    }, []);

    return {
        ...state,
        sendMessage,
        clearChat
    };
}
