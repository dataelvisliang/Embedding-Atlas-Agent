import type { VercelRequest, VercelResponse } from '@vercel/node';

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

const ANALYZER_SYSTEM_PROMPT = `You are a specialized Review Analyzer Agent.

Your task is to analyze a set of hotel reviews and extract:
1. **Category/Theme**: A concise label (2-3 words) describing the main topic (e.g., "Cleanliness Issues", "Noise Complaints", "Excellent Service")
2. **Sentiment**: Overall sentiment (Positive, Negative, or Mixed)
3. **Key Themes**: List of 2-5 specific sub-themes found in the reviews
4. **Top Quotes**: Extract 2-3 representative short quotes (max 100 chars each) that best illustrate the category

Output your analysis as JSON:
{
  "category": "...",
  "sentiment": "Positive|Negative|Mixed",
  "themes": ["theme1", "theme2", ...],
  "quotes": ["quote1", "quote2", "quote3"]
}

Be precise and data-driven. The category should be actionable and specific.`;

interface AnalyzerRequest {
    bin_x: number;
    bin_y: number;
    bin_size?: number;
    limit?: number;
}

interface AnalyzerResponse {
    category: string;
    sentiment: 'Positive' | 'Negative' | 'Mixed';
    themes: string[];
    quotes: string[];
    count: number;
    avg_rating: number;
    review_ids: number[];
    bin_x: number;
    bin_y: number;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
    // CORS headers
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
        const { bin_x, bin_y, bin_size = 1.0, limit = 5 }: AnalyzerRequest = req.body;

        if (typeof bin_x !== 'number' || typeof bin_y !== 'number') {
            return res.status(400).json({ error: 'Invalid request: bin_x and bin_y are required' });
        }

        // This would normally fetch from DuckDB, but since we're server-side,
        // we need to receive the reviews data from the client
        // For now, we'll expect the client to send reviews directly
        const reviews = req.body.reviews;

        if (!reviews || !Array.isArray(reviews)) {
            return res.status(400).json({
                error: 'Reviews array required. Please send reviews data in request body.'
            });
        }

        if (reviews.length === 0) {
            return res.status(200).json({
                category: 'Empty Cluster',
                sentiment: 'Mixed',
                themes: [],
                quotes: [],
                count: 0,
                avg_rating: 0,
                review_ids: [],
                bin_x,
                bin_y
            });
        }

        // Calculate stats
        const ratings = reviews.map((r: any) => r.rating || r.Rating).filter((r: any) => typeof r === 'number');
        const avg_rating = ratings.length > 0
            ? ratings.reduce((a: number, b: number) => a + b, 0) / ratings.length
            : 0;

        // Format reviews for LLM
        const reviewsText = reviews.map((r: any, idx: number) =>
            `[${idx + 1}] Rating: ${r.rating || r.Rating}★\n${r.text || r.description || r.excerpt}`
        ).join('\n\n');

        // Call Analyzer Agent (LLM)
        console.log(`[Analyzer] Analyzing ${reviews.length} reviews at bin (${bin_x}, ${bin_y})`);

        const llmResponse = await fetch(OPENROUTER_API_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': req.headers.referer as string || req.headers.origin as string || 'https://localhost',
                'X-Title': 'Review Analyzer Agent'
            },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: ANALYZER_SYSTEM_PROMPT },
                    { role: 'user', content: `Analyze these ${reviews.length} reviews:\n\n${reviewsText}` }
                ],
                temperature: 0.3,  // Low temp for consistent analysis
                max_tokens: 500
            })
        });

        if (!llmResponse.ok) {
            const errorText = await llmResponse.text();
            console.error('[Analyzer] LLM error:', llmResponse.status, errorText);
            return res.status(llmResponse.status).json({
                error: `Analyzer Agent failed: ${llmResponse.statusText}`
            });
        }

        const llmData = await llmResponse.json();
        const content = llmData.choices?.[0]?.message?.content;

        if (!content) {
            return res.status(500).json({ error: 'No response from Analyzer Agent' });
        }

        // Parse JSON from LLM response
        let analysis: any;
        try {
            // Try to extract JSON from markdown code blocks if present
            const jsonMatch = content.match(/```json\n([\s\S]+?)\n```/) || content.match(/\{[\s\S]+\}/);
            const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : content;
            analysis = JSON.parse(jsonStr);
        } catch (e) {
            console.error('[Analyzer] Failed to parse LLM JSON:', content);
            // Fallback: create a basic analysis
            analysis = {
                category: 'General Reviews',
                sentiment: avg_rating >= 3.5 ? 'Positive' : 'Negative',
                themes: ['Various topics'],
                quotes: []
            };
        }

        const response: AnalyzerResponse = {
            category: analysis.category || 'Unknown',
            sentiment: analysis.sentiment || 'Mixed',
            themes: analysis.themes || [],
            quotes: analysis.quotes || [],
            count: reviews.length,
            avg_rating: Math.round(avg_rating * 10) / 10,
            review_ids: reviews.map((r: any) => r.id || r.__row_index__).filter((id: any) => id !== undefined),
            bin_x,
            bin_y
        };

        console.log(`[Analyzer] Analysis complete: ${response.category} (${response.sentiment})`);
        return res.status(200).json(response);

    } catch (error) {
        console.error('[Analyzer] Error:', error);
        return res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error'
        });
    }
}
