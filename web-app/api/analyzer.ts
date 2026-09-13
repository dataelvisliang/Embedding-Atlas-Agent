import type { VercelRequest, VercelResponse } from '@vercel/node';

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

const ANALYZER_JSON_SCHEMA = {
    name: 'wine_region_analysis',
    strict: true,
    schema: {
        type: 'object', additionalProperties: false,
        required: ['category', 'sentiment', 'themes', 'quotes', 'dominant_theme_membership', 'intent_relevance', 'purity_rationale', 'intent_match_rationale'],
        properties: {
            category: { type: 'string' }, sentiment: { type: 'string', enum: ['Excellent', 'Good', 'Mediocre'] },
            themes: { type: 'array', items: { type: 'string' }, minItems: 0, maxItems: 5 },
            quotes: { type: 'array', items: { type: 'string' }, minItems: 0, maxItems: 3 },
            dominant_theme_membership: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'boolean' } },
            intent_relevance: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'integer', minimum: 0, maximum: 2 } },
            purity_rationale: { type: 'string' }, intent_match_rationale: { type: 'string' }
        }
    }
} as const;

const ANALYZER_SYSTEM_PROMPT = `You are a specialized Wine Review Analyzer Agent.

Your task is to analyze a set of wine reviews and extract:
1. **Category/Theme**: A concise label (2-3 words) describing the main varietal, style, or region (e.g., "Tuscan Sangiovese", "Napa Cabernet", "Crisp White")
2. **Quality Perception**: Overall impression of quality (Excellent, Good, Mediocre)
3. **Flavor Notes**: List of 2-5 specific flavor notes or characteristics found in the reviews (e.g., "cherry", "oak", "earthy", "high tannins")
4. **Top Quotes**: Extract 2-3 representative short quotes (max 100 chars each) that best describe the wine's character
5. **Per-item dominant-theme membership**: Mark whether each sampled review supports the same single dominant theme at the requested finding specificity.
6. **Per-item intent relevance**: 2 directly satisfies the local intent, 1 partially satisfies it or lacks evidence for a soft facet, 0 is irrelevant or contradicted.

Calibration:
- Evaluate ONE finding at the specificity the user requests. A broad umbrella such as 'all white wines', 'all red wines', or one grape variety is not automatically a coherent flavor/style theme. Mark dominant_theme_member=true only when the item's evidence supports the same specific theme as the category.
- The requested number of findings and diversity BETWEEN regions are global search goals. A pure circle containing one appropriate style can score high intent_match even when the user asks for three different styles. Never reward a mixed circle merely because it contains several requested styles.
- Judge every item independently before summarizing. Sweetness, oak, defects, color and dominant fruit can make an item only partial or irrelevant even when its variety matches.
- Price/value without a numeric user cutoff is relative evidence, not a hidden hard threshold. Consider price together with points and review quality.
- Return both assessment arrays in exactly the same order and length as the numbered reviews. Position 1 evaluates review [1], position 2 evaluates review [2], and so on. Never output review IDs.

Output only one JSON object with exactly these keys:
{
  "category": "...",
  "sentiment": "Excellent|Good|Mediocre",
  "themes": ["note1", "note2", ...],
  "quotes": ["quote1", "quote2", "quote3"],
  "dominant_theme_membership": [true, false],
  "intent_relevance": [2, 1],
  "purity_rationale": "one short evidence-based sentence",
  "intent_match_rationale": "one short evidence-based sentence"
}

If the sampled reviews are mixed, still choose the best concise category and mark nonmembers explicitly. Score the supplied reviews only. Do not infer from coordinates, density, or assumed properties not present in the text/metadata. Be precise and data-driven. The category should be informative.`;

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

interface ItemAssessment { id: number; dominant_theme_member: boolean; intent_relevance: 0 | 1 | 2; theme: string | null }
interface ModelAnalysis {
    category: string; sentiment: string; themes: string[]; quotes: string[];
    dominant_theme_membership: boolean[]; intent_relevance: Array<0 | 1 | 2>;
    purity_rationale: string; intent_match_rationale: string;
}

function parseAnalysis(content: string): ModelAnalysis | null {
    try {
        const jsonMatch = content.match(/```json\n([\s\S]+?)\n```/) || content.match(/\{[\s\S]+\}/);
        const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : content;
        const parsed = JSON.parse(jsonStr);
        if (!parsed || typeof parsed !== 'object') return null;
        if (!Array.isArray(parsed.themes)) parsed.themes = [];
        if (!Array.isArray(parsed.quotes)) parsed.quotes = [];
        if (typeof parsed.sentiment !== 'string') parsed.sentiment = 'Good';
        if (typeof parsed.category !== 'string' || !parsed.category.trim()) return null;
        if (!Array.isArray(parsed.dominant_theme_membership) || !parsed.dominant_theme_membership.every((value: unknown) => typeof value === 'boolean')) return null;
        if (!Array.isArray(parsed.intent_relevance) || !parsed.intent_relevance.every((value: unknown) => [0, 1, 2].includes(value as number))) return null;
        return parsed;
    } catch {
        return null;
    }
}

export function deriveEvidenceScores(reviewIds: number[], analysis: ModelAnalysis) {
    const expected = [...new Set(reviewIds)];
    if (expected.length !== reviewIds.length || analysis.dominant_theme_membership.length !== expected.length ||
        analysis.intent_relevance.length !== expected.length) return null;
    const assessments = expected.map((id, index): ItemAssessment => ({
        id, dominant_theme_member: analysis.dominant_theme_membership[index],
        intent_relevance: analysis.intent_relevance[index], theme: analysis.dominant_theme_membership[index] ? analysis.category : null
    }));
    const dominantCount = assessments.filter(item => item.dominant_theme_member).length;
    const relevanceTotal = assessments.reduce((sum, item) => sum + item.intent_relevance, 0);
    return {
        purity: Math.round(dominantCount / expected.length * 1000) / 1000,
        intent_match: Math.round(relevanceTotal / (2 * expected.length) * 1000) / 1000,
        outlier_count: expected.length - dominantCount,
        item_assessments: assessments
    };
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
        const reviewIds = reviews.map((r: any) => r.id ?? r.__row_index__).filter((id: unknown): id is number => Number.isSafeInteger(id));
        if (reviewIds.length !== reviews.length || new Set(reviewIds).size !== reviewIds.length) {
            return res.status(400).json({ error: 'Every review requires one distinct integer ID.' });
        }
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
        let analysis: ModelAnalysis | null = null;
        let evidenceScores: ReturnType<typeof deriveEvidenceScores> = null;
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
            const parsed = parseAnalysis(content);
            const derived = parsed ? deriveEvidenceScores(reviewIds, parsed) : null;
            if (parsed && derived) { analysis = parsed; evidenceScores = derived; break; }
            failureReasons.push(parsed ? 'assessment_id_mismatch' : content.includes('{') ? 'schema_invalid_or_malformed_json' : 'invalid_json');
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
                review_ids: reviewIds,
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


        if (!evidenceScores) throw new Error('Analyzer evidence scores were not derived');
        const response: AnalyzerResponse & { item_assessments: ItemAssessment[] } = {
            category: analysis.category || 'Unknown',
            sentiment: analysis.sentiment || 'Good',
            themes: analysis.themes || [],
            quotes: analysis.quotes || [],
            count: reviews.length,
            avg_points: Math.round(avg_points * 10) / 10,
            review_ids: reviewIds,
            region_id: region.id,
            center_x: region.center_x,
            center_y: region.center_y,
            radius: region.radius,
            purity: evidenceScores.purity,
            purity_rationale: String(analysis.purity_rationale || 'No rationale returned.'),
            intent_match: evidenceScores.intent_match,
            intent_match_rationale: String(analysis.intent_match_rationale || 'No rationale returned.'),
            hard_constraint_match: true,
            outlier_count: evidenceScores.outlier_count,
            item_assessments: evidenceScores.item_assessments,
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
