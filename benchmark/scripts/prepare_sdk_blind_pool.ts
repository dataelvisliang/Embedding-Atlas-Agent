import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getServerCoordinator } from '../../web-app/api/serverDuckDb';

type Geometry = { id: string; center_x: number; center_y: number; radius: number };
type Filters = { countries?: string[]; varieties?: string[]; min_price?: number; max_price?: number; min_points?: number; max_points?: number };
type Query = { query_id: string; query: string; intent: string; hard_constraints?: Record<string, unknown> };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const quote = (value: unknown) => `'${String(value).replace(/'/g, "''")}'`;
const normalize = (value: unknown): unknown => {
    if (typeof value === 'bigint') return Number(value);
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
    return value;
};

function predicate(region: Geometry, filters: Filters): string {
    const x = Number(region.center_x), y = Number(region.center_y), radius = Number(region.radius);
    if (![x, y, radius].every(Number.isFinite) || radius <= 0) throw new Error(`Invalid geometry for ${region.id}`);
    const clauses = [`(projection_x - ${x}) * (projection_x - ${x}) + (projection_y - ${y}) * (projection_y - ${y}) <= ${radius * radius}`];
    if (filters.countries?.length) clauses.push(`country IN (${filters.countries.map(quote).join(',')})`);
    if (filters.varieties?.length) clauses.push(`variety IN (${filters.varieties.map(quote).join(',')})`);
    if (Number.isFinite(filters.min_price)) clauses.push(`price >= ${Number(filters.min_price)}`);
    if (Number.isFinite(filters.max_price)) clauses.push(`price <= ${Number(filters.max_price)}`);
    if (Number.isFinite(filters.min_points)) clauses.push(`points >= ${Number(filters.min_points)}`);
    if (Number.isFinite(filters.max_points)) clauses.push(`points <= ${Number(filters.max_points)}`);
    return clauses.join(' AND ');
}

function args(): { run: string; output: string } {
    const values = process.argv.slice(2);
    const get = (flag: string) => values[values.indexOf(flag) + 1];
    const run = get('--run');
    const output = get('--output');
    if (!run || !output) throw new Error('Usage: --run <sdk pilot jsonl> --output <blind pool jsonl>');
    return { run: path.resolve(root, run), output: path.resolve(root, output) };
}

async function main() {
    const options = args();
    const runs = (await readFile(options.run, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const queryRows = (await readFile(path.join(root, 'benchmark/queries/queries_v1.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as Query);
    const queries = new Map(queryRows.map(query => [query.query_id, query]));
    const coordinator = await getServerCoordinator();
    const blind: Record<string, unknown>[] = [];
    const sources: Record<string, unknown> = {};

    for (const run of runs) {
        const query = queries.get(run.query_id);
        if (!query) throw new Error(`Missing query ${run.query_id}`);
        const finish = [...run.trajectory].reverse().find((event: any) => event.tool === 'finish_search' && event.status === 'completed');
        const selectedIds: string[] = finish?.parameters?.finding_ids || [];
        const geometries = new Map<string, Geometry>();
        for (const event of run.trajectory) {
            for (const region of event.parameters?.regions || []) geometries.set(region.id, region);
        }
        const modelEvidence = new Map((run.accepted || []).map((region: any) => [region.id, region]));
        const filters: Filters = run.compiled_task?.hard_filters || {};
        for (const regionId of selectedIds) {
            const geometry = geometries.get(regionId);
            if (!geometry) throw new Error(`No inspected geometry for ${run.query_id}:${regionId}`);
            const result = await coordinator.query(`
                SELECT __row_index__ AS id, title, description, points, price, variety, country
                FROM reviews WHERE ${predicate(geometry, filters)}
                ORDER BY hash(__row_index__), __row_index__ LIMIT 12
            `);
            const samples = normalize(result.toArray()) as Array<Record<string, unknown>>;
            const reviewIds = samples.map(sample => Number(sample.id));
            const digest = createHash('sha256').update(`${run.query_id}:${reviewIds.join(',')}`).digest('hex').slice(0, 12);
            const unitId = `region-${digest}`;
            blind.push({
                query_id: run.query_id, query: query.query, intent: query.intent,
                explicit_constraints: query.hard_constraints || {}, unit_type: 'region', unit_id: unitId,
                review_ids: reviewIds, samples, purity: null, intent_match: null,
                annotator_id: null, notes: null
            });
            sources[`${run.query_id}:${unitId}`] = {
                run_file: path.relative(root, options.run).replace(/\\/g, '/'), region_id: regionId,
                geometry, compiled_filters: filters, hidden_model_evidence: modelEvidence.get(regionId) || null
            };
            for (const sample of samples) {
                const itemId = `review-${sample.id}`;
                if (blind.some(row => row.query_id === run.query_id && row.unit_id === itemId)) continue;
                blind.push({
                    query_id: run.query_id, query: query.query, intent: query.intent,
                    explicit_constraints: query.hard_constraints || {}, unit_type: 'item', unit_id: itemId,
                    review_id: Number(sample.id), title: sample.title, description: sample.description,
                    points: sample.points, price: sample.price, variety: sample.variety, country: sample.country,
                    relevance: null, theme: null, annotator_id: null, notes: null
                });
                sources[`${run.query_id}:${itemId}`] = { parent_region_units: [] };
            }
            for (const id of reviewIds) {
                const source = sources[`${run.query_id}:review-${id}`] as { parent_region_units: string[] };
                if (!source.parent_region_units.includes(unitId)) source.parent_region_units.push(unitId);
            }
        }
    }
    blind.sort((a, b) => `${a.query_id}:${a.unit_type}:${a.unit_id}`.localeCompare(`${b.query_id}:${b.unit_type}:${b.unit_id}`));
    await writeFile(options.output, blind.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
    await writeFile(options.output.replace(/\.jsonl$/, '.sources.json'), JSON.stringify(sources, null, 2) + '\n', 'utf8');
    console.log(JSON.stringify({ output: options.output, units: blind.length, regions: blind.filter(row => row.unit_type === 'region').length, items: blind.filter(row => row.unit_type === 'item').length }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
