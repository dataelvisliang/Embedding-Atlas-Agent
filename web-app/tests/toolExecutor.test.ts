import assert from 'node:assert/strict';

import { ToolExecutor } from '../src/tools/toolExecutor';

class FixtureCoordinator {
    async query(sql: string) {
        if (sql.includes('COUNT(*) AS density')) return { toArray: () => [{ density: 3 }] };
        if (sql.includes('SELECT __row_index__')) {
            return {
                toArray: () => [{
                    __row_index__: 42, points: 90, description: 'Savory red fixture.', title: 'Fixture',
                    price: 20, variety: 'Syrah', country: 'France', projection_x: 1, projection_y: 1, neighbors: null
                }]
            };
        }
        return { toArray: () => [] };
    }
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body || '{}'));
    if (body.region?.id === 'bad') throw new Error('fixture analyzer outage');
    return new Response(JSON.stringify({
        category: 'Savory Syrah', sentiment: 'Good', themes: ['pepper'], quotes: ['pepper fixture'],
        purity: 0.8, purity_rationale: 'fixture', intent_match: 0.8, intent_match_rationale: 'fixture',
        hard_constraint_match: true, outlier_count: 0, review_ids: [42]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

try {
    const executor = new ToolExecutor(new FixtureCoordinator(), { analyzerUrl: 'http://fixture/analyzer' });
    const result = await executor.execute({
        id: 'batch', type: 'function', function: {
            name: 'inspect_regions',
            arguments: JSON.stringify({
                intent: 'savory red wine', sample_size: 3,
                regions: [
                    { id: 'bad', center_x: 0, center_y: 0, radius: 1 },
                    { id: 'good', center_x: 2, center_y: 2, radius: 1 }
                ]
            })
        }
    });
    assert.equal(result.error, undefined, 'one failed Analyzer circle must not fail its whole batch');
    assert.equal(result.result.regions.length, 2);
    assert.equal(result.result.regions.find((region: { id: string }) => region.id === 'bad').analysis_failed, true);
    assert.equal(result.result.regions.find((region: { id: string }) => region.id === 'good').analysis_failed, undefined);
} finally {
    globalThis.fetch = originalFetch;
}

console.log('toolExecutor tests passed');
