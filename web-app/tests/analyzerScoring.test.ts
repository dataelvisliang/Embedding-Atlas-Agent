import assert from 'node:assert/strict';

import { deriveEvidenceScores } from '../api/analyzer';

const ids = Array.from({ length: 12 }, (_, index) => index + 1);
const analysis = {
    category: 'Floral Prosecco', sentiment: 'Good', themes: ['flowers'], quotes: ['sample'],
    purity_rationale: 'Eight samples support the specific dominant style.',
    intent_match_rationale: 'Ten direct and two partial matches.',
    dominant_theme_membership: ids.map((_, index) => index < 8),
    intent_relevance: ids.map((_, index) => (index < 10 ? 2 : 1) as 0 | 1 | 2)
};

const scores = deriveEvidenceScores(ids, analysis);
assert.deepEqual(scores && {
    purity: scores.purity, intent_match: scores.intent_match, outlier_count: scores.outlier_count
}, { purity: 0.667, intent_match: 0.917, outlier_count: 4 });

assert.equal(deriveEvidenceScores(ids, { ...analysis, intent_relevance: analysis.intent_relevance.slice(1) }), null,
    'short arrays must fail instead of silently changing denominators');
assert.equal(deriveEvidenceScores(ids, { ...analysis, dominant_theme_membership: [...analysis.dominant_theme_membership, true] }), null,
    'long arrays must fail instead of silently changing denominators');

console.log('analyzer scoring: deterministic aggregation passed');
