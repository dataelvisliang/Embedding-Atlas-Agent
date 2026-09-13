import type { VercelRequest, VercelResponse } from '@vercel/node';

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

const ANALYZER_JSON_SCHEMA = {
    name: 'wine_region_analysis',
    strict: true,
    schema: {
        type: 'object', additionalProperties: false,
        required: ['category', 'sentiment', 'themes', 'quotes', 'purity', 'purity_rationale', 'intent_match', 'intent_match_rationale', 'hard_constraint_match', 'outlier_count'],
        properties: {
            category: { type: 'string' }, sentiment: { type: 'string', enum: ['Excellent', 'Good', 'Mediocre'] },
            themes: { type: 'array', items: { type: 'string' }, minItems: 0, maxItems: 5 },
            quotes: { type: 'array', items: { type: 'string' }, minItems: 0, maxItems: 3 },
            purity: { type: 'number', minimum: 0, maximum: 1 }, purity_rationale: { type: 'string' },
            intent_match: { type: 'number', minimum: 0, maximum: 1 }, intent_match_rationale: { type: 'string' },
            hard_constraint_match: { type: 'boolean' }, outlier_count: { type: 'integer', minimum: 0 }
        }
    }
} as const;

const ANALYZER_SYSTEM_PROMPT = `You are a specialized Wine Review Analyzer Agent.

Your task is to analyze a set of wine reviews and extract:
1. **Category/Theme**: A concise label (2-3 words) describing the main varietal, style, or region (e.g., "Tuscan Sangiovese", "Napa Cabernet", "Crisp White")
2. **Quality Perception**: Overall impression of quality (Excellent, Good, Mediocre)
3. **Flavor Notes**: List of 2-5 specific flavor notes or characteristics found in the reviews (e.g., "cherry", "oak", "earthy", "high tannins")
4. **Top Quotes**: Extract 2-3 representative short quotes (max 100 chars each) that best describe the wine's character
5. **Semantic Purity**: A score from 0.0 to 1.0 estimating the share of sampled reviews that support one dominant coherent wine theme. A region can be pure even when it is irrelevant to the user's intent.
6. **Intent Match**: A score from 0.0 to 1.0 estimating how strongly the sampled region satisfies the supplied user intent and constraints. A region can match weakly even when internally pure.

Calibration:
- Evaluate ONE finding at the specificity the user requests. A broad umbrella such as 'all white wines' is not one coherent style if the sample spans unrelated styles. Use lower purity for such a mixed sample.
- The requested number of findings and diversity BETWEEN regions are global search goals. A pure circle containing one appropriate style can score high intent_match even when the user asks for three different styles. Never reward a mixed circle merely because it contains several requested styles.
- 0.90-1.00: nearly all sampled evidence supports the criterion
- 0.70-0.89: strong majority support
- 0.40-0.69: mixed or partial support
- 0.10-0.39: weak support
- 0.00-0.09: absent or contradicted

Output only one JSON object with exactly these keys:
{
  "category": "...",
  "sentiment": "Excellent|Good|Mediocre",
  "themes": ["note1", "note2", ...],
  "quotes": ["quote1", "quote2", "quote3"],
  "purity": 0.0,
  "purity_rationale": "one short evidence-based sentence",
  "intent_match": 0.0,
  "intent_match_rationale": "one short evidence-based sentence",
  "hard_constraint_match": true,
  "outlier_count": 0
}

If the sampled reviews are mixed, still choose the best concise category and lower the purity score. hard_constraint_match must be false if sampled evidence contradicts an explicit user requirement such as color, price, score, country, or variety. Score the supplied reviews only. Do not infer from coordinates or density. Be precise and data-driven. The category should be informative.`;

interface AnalyzerRequest {
    region: {
        id?: string;
        center_x: number;
        center_y: number;
        radius: number;
    };
    intent: string;
    reviews: any[];
}

interface AnalyzerResponse {
    category: string;
    sentiment: string;
    themes: string[];
    quotes: string[];
    count: number;
    avg_points: number;
    review_ids: number[];
    region_id?: string;
    center_x: number;
    center_y: number;
    radius: number;
    purity: number;
    purity_rationale: string;
    intent_match: number;
    intent_match_rationale: string;
    hard_constraint_match: boolean | null;
    outlier_count: number;
    analyzer_status?: string;
    analyzer_attempts?: number;
    analysis_failed?: boolean;
}

const normalizedScore = (value: unknown, fallback = 0.5): number => {
    if (typeof value === 'string') {
        const label = value.trim().toLowerCase();
        if (['none', 'absent', 'no', 'very low'].includes(label)) return 0;
        if (['low', 'weak'].includes(label)) return 0.25;
        if (['medium', 'moderate', 'mixed', 'partial'].includes(label)) return 0.5;
        if (['high', 'strong'].includes(label)) return 0.75;
        if (['very high', 'excellent', 'perfect'].includes(label)) return 1;
    }
    const score = Number(value);
    return Number.isFinite(score) ? Math.round(Math.min(1, Math.max(0, score)) * 1000) / 1000 : fallback;
};

function parseAnalysis(content: string): any | null {
    try {
        const jsonMatch = content.match(/```json\n([\s\S]+?)\n```/) || content.match(/\{[\s\S]+\}/);
        const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : content;
        const parsed = JSON.parse(jsonStr);
        if (!parsed || typeof parsed !== 'object') return null;
        if (!Array.isArray(parsed.themes)) parsed.themes = [];
        if (!Array.isArray(parsed.quotes)) parsed.quotes = [];
        if (typeof parsed.sentiment !== 'string') parsed.sentiment = 'Good';
        if (typeof parsed.category !== 'string' || !parsed.category.trim()) return null;
        if (![parsed.purity, parsed.intent_match].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1)) return null;
        if (typeof parsed.hard_constraint_match !== 'boolean') return null;
        return parsed;
    } catch {
        return null;
    }
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
    const model = process.env.OPENROUTER_ANALYZER_MODEL || process.env.OPENROUTER_MODEL || 'z-ai/glm-5.3-flash';

    if (!apiKey) {
        return res.status(500).json({ error: 'OpenRouter API key not configured' });
    }

    try {
        const { region, reviews, intent }: AnalyzerRequest = req.body;

        if (!region || typeof region.center_x !== 'number' || typeof region.center_y !== 'number' || typeof region.radius !== 'number') {
            return res.status(400).json({ error: 'Invalid request: a circular region with center_x, center_y, and radius is required' });
        }

        // This would normally fetch from DuckDB, but since we're server-side,
        // we need to receive the reviews data from the client
        // For now, we'll expect the client to send reviews directly
        if (!reviews || !Array.isArray(reviews)) {
            return res.status(400).json({
                error: 'Reviews array required. Please send reviews data in request body.'
            });
        }

        if (reviews.length === 0) {
            return res.status(200).json({
                category: 'Empty Cluster',
                sentiment: 'N/A',
                themes: [],
                quotes: [],
                count: 0,
                avg_points: 0,
                review_ids: [],
                region_id: region.id,
                center_x: region.center_x,
                center_y: region.center_y,
                radius: region.radius,
                purity: 0,
                purity_rationale: 'The circle contains no reviews.',
                intent_match: 0,
                intent_match_rationale: 'No evidence is available for intent matching.',
                hard_constraint_match: false,
                outlier_count: 0
            });
        }

        // Calculate stats
        const points = reviews.map((r: any) => r.points || r.rating || r.Rating).filter((r: any) => typeof r === 'number');
        const avg_points = points.length > 0
            ? points.reduce((a: number, b: number) => a + b, 0) / points.length
            : 0;

        // Format reviews for LLM
        const reviewsText = reviews.map((r: any, idx: number) =>
            `[${idx + 1}] ID: ${r.id ?? r.__row_index__} | Points: ${r.points ?? r.rating ?? r.Rating} | Price: ${r.price ?? 'unknown'} | Country: ${r.country ?? 'unknown'} | Variety: ${r.variety ?? 'unknown'}\nTitle: ${r.title || 'Unknown'}\n${String(r.text || r.description || r.excerpt || '').slice(0, 800)}`
        ).join('\n\n');

        console.log(`[Analyzer] Analyzing ${reviews.length} reviews in circle (${region.center_x}, ${region.center_y}, r=${region.radius})`);

        const callAnalyzer = async (retry = false) => {
            const abort = new AbortController();
            const timeout = setTimeout(() => abort.abort(), 20_000);
            let llmResponse: Response;
            try {
                llmResponse = await fetch(OPENROUTER_API_URL, {
                    method: 'POST', signal: abort.signal,
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                        'HTTP-Referer': req.headers.referer as string || req.headers.origin as string || 'https://localhost',
                        'X-Title': 'Wine Review Analyzer Agent'
                    },
                    body: JSON.stringify({
                        model,
                        messages: [
                            { role: 'system', content: ANALYZER_SYSTEM_PROMPT },
                            { role: 'user', content: `${retry ? 'Retry: return only the required JSON object. Do not add explanations.\n\n' : ''}User intent: ${String(intent || 'Open-ended wine theme discovery').slice(0, 5000)}\n\nAnalyze these ${reviews.length} sampled reviews. If evidence is broad or mixed, return lower purity/intent_match rather than failing.\n\n${reviewsText}` }
                        ],
                        temperature: 0,
                        max_tokens: 900,
                        response_format: { type: 'json_schema', json_schema: ANALYZER_JSON_SCHEMA },
                        reasoning: { effort: 'low', exclude: true },
                        plugins: [{ id: 'response-healing' }]
                    })
                });
                if (!llmResponse.ok) {
                    const errorText = await llmResponse.text();
                    console.error('[Analyzer] LLM error:', llmResponse.status, errorText);
                    throw new Error(`Analyzer Agent failed: ${llmResponse.statusText}`);
                }
                return await llmResponse.json();
            } finally {
                clearTimeout(timeout);
            }
        };

        const extractContent = (data: any): string => {
            const message = data.choices?.[0]?.message;
            let content = message?.content;
            if (!content && message?.reasoning_details) {
                content = message.reasoning_details.map((d: any) => d.content).join('\n');
            }
            return content || '';
        };

        let llmData: any;
        let content = '';
        let analysis: any = null;
        const failureReasons: string[] = [];
        let attempts = 0;
        // SearchSession owns the single bounded retry. No hidden multiplicative retries.
        for (let attempt = 0; attempt < 1; attempt++) {
            attempts = attempt + 1;
            try {
                llmData = await callAnalyzer(attempt > 0);
            } catch (error) {
                failureReasons.push(`request_error:${error instanceof Error ? error.name : 'unknown'}`);
                continue;
            }
            content = extractContent(llmData);
            if (!content.trim()) {
                failureReasons.push('empty_content');
                continue;
            }
            analysis = parseAnalysis(content);
            if (analysis) break;
            failureReasons.push(content.includes('{') ? 'schema_invalid_or_malformed_json' : 'invalid_json');
        }

        if (!analysis) {
            console.error('[Analyzer] Failed to parse valid LLM JSON after retry:', content);
            const failedResponse: AnalyzerResponse & { analyzer_usage?: unknown } = {
                category: 'Analysis failed',
                sentiment: 'N/A',
                themes: [],
                quotes: [],
                count: reviews.length,
                avg_points: Math.round(avg_points * 10) / 10,
                review_ids: reviews.map((r: any) => r.id || r.__row_index__).filter((id: any) => id !== undefined),
                region_id: region.id,
                center_x: region.center_x,
                center_y: region.center_y,
                radius: region.radius,
                purity: 0,
                purity_rationale: `Analyzer failed after recovery attempts: ${failureReasons.slice(-3).join(', ') || 'unknown_failure'}.`,
                intent_match: 0,
                intent_match_rationale: 'Analyzer did not return valid structured evidence after retry.',
                hard_constraint_match: false,
                outlier_count: reviews.length,
                analysis_failed: true,
                analyzer_status: failureReasons.at(-1) || 'unknown_failure',
                analyzer_attempts: attempts,
                analyzer_usage: llmData?.usage
            };
            return res.status(200).json(failedResponse);
        }

        console.log('[Analyzer] Extracted content:', content.substring(0, 200) + '...');


        const response: AnalyzerResponse = {
            category: analysis.category || 'Unknown',
            sentiment: analysis.sentiment || 'Good',
            themes: analysis.themes || [],
            quotes: analysis.quotes || [],
            count: reviews.length,
            avg_points: Math.round(avg_points * 10) / 10,
            review_ids: reviews.map((r: any) => r.id || r.__row_index__).filter((id: any) => id !== undefined),
            region_id: region.id,
            center_x: region.center_x,
            center_y: region.center_y,
            radius: region.radius,
            purity: normalizedScore(analysis.purity),
            purity_rationale: String(analysis.purity_rationale || 'No rationale returned.'),
            intent_match: normalizedScore(analysis.intent_match),
            intent_match_rationale: String(analysis.intent_match_rationale || 'No rationale returned.'),
            hard_constraint_match: analysis.hard_constraint_match,
            outlier_count: Math.max(0, Math.min(reviews.length, Math.round(Number(analysis.outlier_count) || 0))),
            analyzer_status: 'ok',
            analyzer_attempts: attempts
        };

        const responseWithUsage = {
            ...response,
            analyzer_usage: llmData.usage
        };

        console.log(`[Analyzer] Analysis complete: ${response.category} (${response.sentiment})`);
        return res.status(200).json(responseWithUsage);

    } catch (error) {
        console.error('[Analyzer] Error:', error);
        return res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error'
        });
    }
}
