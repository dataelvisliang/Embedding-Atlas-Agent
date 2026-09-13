import assert from 'node:assert/strict';
import { tool } from '@openai/agents';
import { SearchSession } from '../src/agent/searchSession';
import { taskSchema, actionSchemas, jsonSchemaFor } from '../src/agent/searchContract';
import type { ActionName } from '../src/agent/searchContract';
import type { ToolCall, ToolResult } from '../src/tools/toolExecutor';

const bounds = { min_x: 0, max_x: 20, min_y: 0, max_y: 20 };
for (const name of Object.keys(actionSchemas) as ActionName[]) {
    assert.doesNotThrow(() => tool({ name, description: name, parameters: jsonSchemaFor(name), strict: false, execute: async () => 'fixture' }));
}
const baseTask = { mode: 'exploration', target_count: 3, finding_unit: 'one coherent wine theme', require_diversity: true, hard_filters: { max_price: 25 }, filter_sources: [{ field: 'max_price', quote: 'under $25' }], evidence_requirements: ['savory red'] } as const;
const task = () => taskSchema.parse(baseTask);
const circles = [0, 1, 2].map(i => ({ id: `c${i}`, center_x: 3 + i * 6, center_y: 5, radius: 2, density: 100 }));
class Fixture {
    calls: ToolCall[] = [];
    purity = .9;
    intent = .9;
    failure = false;
    duplicate = false;
    price = 20;
    constraint: boolean | null = true;
    async execute(call: ToolCall): Promise<ToolResult> {
        this.calls.push(call);
        const a = JSON.parse(call.function.arguments);
        const name = call.function.name;
        if (name === 'scan_projection') return { name, call_id: call.id, result: { regions: circles } };
        if (name === 'subdivide_region') return { name, call_id: call.id, result: { children: [
            { id: 'child', center_x: a.center_x, center_y: a.center_y, radius: .5, density: 10 },
            { id: 'escaped', center_x: 99, center_y: 99, radius: 1, density: 10 }
        ] } };
        if (name === 'compare_regions') return { name, call_id: call.id, result: { regions: a.regions } };
        return { name, call_id: call.id, result: { regions: a.regions.map((r: { id: string }, index: number) => ({
            ...r, category: this.duplicate ? 'same' : `theme${r.id}`, themes: [this.duplicate ? 'same' : `flavor${r.id}`],
            quotes: ['sample'], purity: this.purity, intent_match: this.intent, hard_constraint_match: this.constraint,
            purity_rationale: 'coherent sample', intent_match_rationale: 'sample matches the query',
            analysis_failed: this.failure, reviews: [0, 1, 2].map(n => ({ id: index * 10 + n, price: this.price })), density: 100
        })) } };
    }
}
async function setup(overrides = {}) {
    const s = new SearchSession('Find three savory red themes under $25', bounds);
    const f = new Fixture();
    await s.act('define_task', { ...task(), ...overrides }, f);
    await s.act('scan_projection', { grid_size: 6, reason: 'cover the map' }, f);
    return { s, f };
}
const inspect = (s: SearchSession, f: Fixture, region_ids = ['c0', 'c1', 'c2']) => s.act('inspect_regions', { region_ids, reason: 'inspect distinct areas' }, f);
const finish = (s: SearchSession, f: Fixture) => s.act('finish_search', { reason: 'sufficient_evidence', finding_ids: ['c0', 'c1', 'c2'], explanation: 'Three sampled themes match.', distinctions: ['flavor c0', 'flavor c1', 'flavor c2'] }, f);

// A successful one-batch search is valid; refinement is optional.
{
    const { s, f } = await setup(); await inspect(s, f); await finish(s, f);
    assert.equal(s.terminal?.state, 'success');
    assert.equal(s.snapshot().stop_reason, s.terminal?.reason);
    const count = f.calls.length;
    await s.act('scan_projection', { grid_size: 4, reason: 'after stop' }, f);
    assert.equal(f.calls.length, count, 'terminal state is absorbing');
    assert.equal(s.presentation()?.result.record_ids.length, 9);
}
// Provenance, immutable scope and batch constraints cannot be weakened by the model.
{
    const { s, f } = await setup();
    await inspect(s, f, ['invented']); await inspect(s, f, ['c0']);
    assert.equal(f.calls.length, 1);
    await s.act('define_task', { ...task(), hard_filters: {} }, f);
    assert.equal(s.task?.hard_filters.max_price, 25);
    await inspect(s, f);
    assert.equal(JSON.parse(f.calls[1].function.arguments).search_context.hard_filters.max_price, 25);
    await inspect(s, f);
    assert.equal(f.calls.length, 2, 'successful samples cannot be repeated');
}
// Relevant mixed evidence permits refinement; irrelevant or accepted evidence does not.
{
    const { s, f } = await setup(); f.purity = .5; await inspect(s, f);
    await finish(s, f); assert.equal(s.terminal, null);
    await s.act('subdivide_region', { parent_id: 'c0', reason: 'high intent but mixed' }, f);
    assert.equal(s.candidates.get('child')?.depth, 1);
    assert.equal(s.candidates.has('escaped'), false, 'children must be contained in parent');
    await s.act('subdivide_region', { parent_id: 'c0', reason: 'repeat' }, f);
    assert.equal(f.calls.length, 3);
    f.purity = .9; await inspect(s, f, ['child']);
    assert.equal(s.candidates.get('child')?.status, 'accepted');
}
// Failure is unknown evidence and never semantic no-progress. Retry is bounded.
{
    const { s, f } = await setup(); f.failure = true; await inspect(s, f);
    assert.equal(s.snapshot().no_progress_rounds, 0);
    assert.equal(s.candidates.get('c0')?.status, 'failed');
    await inspect(s, f);
    assert.equal(s.terminal?.state, 'runtime_error');
}
// Unknown hard-constraint judgment fails closed.
{
    const { s, f } = await setup(); f.constraint = null; await inspect(s, f);
    assert.equal(s.snapshot().accepted_region_count, 0);
    assert.equal(s.candidates.get('c0')?.status, 'failed');
}
// Duplicate themes must not satisfy a diversity count.
{
    const { s, f } = await setup(); f.duplicate = true; await inspect(s, f);
    assert.equal(s.snapshot().accepted_region_count, 1);
    await finish(s, f); assert.equal(s.terminal, null);
}
// Comparison mode cannot succeed before the chosen evidence has been compared.
{
    const { s, f } = await setup({ mode: 'comparison' }); await inspect(s, f);
    await finish(s, f); assert.equal(s.terminal, null);
    await s.act('compare_regions', { region_ids: ['c0', 'c1', 'c2'], reason: 'contrast selected evidence' }, f);
    await finish(s, f); assert.equal(s.terminal?.state, 'success');
}
// Budget expiration preserves state and prevents new execution.
{
    let now = 0; const s = new SearchSession('query', bounds, {}, () => now); const f = new Fixture();
    now = 120001; await s.act('define_task', task(), f);
    assert.equal(s.terminal?.state, 'budget_exhausted'); assert.equal(f.calls.length, 0);
}
// Unsupported modes are explicit, never disguised as successful region retrieval.
{
    const { s } = await setup({ mode: 'exact' }); assert.equal(s.terminal?.state, 'unsupported');
}
assert.equal(taskSchema.safeParse({ ...task(), hard_filters: { min_price: 40, max_price: 20 } }).success, false);
assert.equal(taskSchema.safeParse({ ...task(), target_count: 0 }).success, false);
{
    const s = new SearchSession('Find savory reds', bounds); const f = new Fixture();
    await s.act('define_task', { ...task(), hard_filters: { max_points: 0 }, filter_sources: [] }, f);
    assert.equal(s.task, null, 'invented numeric defaults cannot define a task');
}
{
    const s = new SearchSession('Find savory reds from California', bounds); const f = new Fixture();
    await s.act('define_task', { ...task(), hard_filters: { countries: ['US'] }, filter_sources: [{ field: 'countries', quote: 'California' }] }, f);
    assert.equal(s.task, null, 'the Agent cannot silently normalize a string hard filter');
    s.seedOracleTask({ ...task(), hard_filters: { countries: ['US'] }, filter_sources: [{ field: 'countries', quote: 'California' }] });
    assert.deepEqual(s.task?.hard_filters.countries, ['US'], 'a separately labelled oracle annotation can normalize values');
}
{
    const { s, f } = await setup(); f.price = 40; await inspect(s, f);
    assert.equal(s.snapshot().accepted_region_count, 0);
    assert.equal(s.candidates.get('c0')?.error, 'sample_scope_mismatch');
}
console.log('search contract: all invariant scenarios passed');
