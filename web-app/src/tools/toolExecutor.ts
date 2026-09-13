/* DuckDB rows and LLM tool payloads are runtime-shaped at this browser boundary. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Coordinator } from '@uwdata/mosaic-core';

export interface ToolCall {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
}

export interface ToolResult {
    name: string;
    call_id: string;
    result: any;
    error?: string;
}

export interface SearchFilters {
    terms?: string[];
    term_mode?: 'AND' | 'OR';
    countries?: string[];
    varieties?: string[];
    min_points?: number;
    max_points?: number;
    min_price?: number;
    max_price?: number;
}

export interface SearchContext {
    version: 1;
    hard_filters: SearchFilters;
    semantic_intent: string;
    projection_state?: { visited_region_ids?: string[]; refinement_depth?: number };
    evidence_state?: { accepted_region_ids?: string[]; frontier_region_ids?: string[] };
}

interface RegionProbe {
    id?: string;
    center_x: number;
    center_y: number;
    radius: number;
}

const quote = (value: unknown) => `'${String(value).replace(/'/g, "''")}'`;
const finite = (value: unknown, fallback: number) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value: unknown, fallback: number, min: number, max: number) => Math.min(max, Math.max(min, finite(value, fallback)));

function filterClause(filters: SearchFilters = {}): string {
    const conditions: string[] = [];
    const terms = Array.isArray(filters.terms) ? filters.terms.map(String).map(t => t.trim()).filter(Boolean).slice(0, 10) : [];
    if (terms.length) {
        const termConditions = terms.map(term => `description ILIKE ${quote(`%${term}%`)}`);
        conditions.push(`(${termConditions.join(filters.term_mode === 'OR' ? ' OR ' : ' AND ')})`);
    }
    if (filters.countries?.length) conditions.push(`country IN (${filters.countries.slice(0, 20).map(quote).join(',')})`);
    if (filters.varieties?.length) conditions.push(`variety IN (${filters.varieties.slice(0, 20).map(quote).join(',')})`);
    if (Number.isFinite(filters.min_points)) conditions.push(`points >= ${Number(filters.min_points)}`);
    if (Number.isFinite(filters.max_points)) conditions.push(`points <= ${Number(filters.max_points)}`);
    if (Number.isFinite(filters.min_price)) conditions.push(`price >= ${Number(filters.min_price)}`);
    if (Number.isFinite(filters.max_price)) conditions.push(`price <= ${Number(filters.max_price)}`);
    return conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
}

function contextFromArgs(args: SearchFilters & { search_context?: unknown }): SearchContext | null {
    const value = args.search_context;
    if (!value || typeof value !== 'object') return null;
    const context = value as Partial<SearchContext>;
    if (!context.hard_filters || typeof context.hard_filters !== 'object') return null;
    return {
        version: 1,
        hard_filters: context.hard_filters,
        semantic_intent: typeof context.semantic_intent === 'string' ? context.semantic_intent : '',
        projection_state: context.projection_state,
        evidence_state: context.evidence_state
    };
}

function effectiveFilters(args: SearchFilters & { search_context?: unknown }): SearchFilters {
    const context = contextFromArgs(args);
    // Context-owned constraints win over agent-provided ad-hoc arguments.
    return context ? { ...args, ...context.hard_filters } : args;
}

function appliedContext(args: SearchFilters & { search_context?: unknown }): SearchContext | null {
    return contextFromArgs(args);
}

function circlePredicate(region: RegionProbe): string {
    const x = finite(region.center_x, 0);
    const y = finite(region.center_y, 0);
    const radius = clamp(region.radius, 1, 0.0001, 100000);
    return `(projection_x - ${x}) * (projection_x - ${x}) + (projection_y - ${y}) * (projection_y - ${y}) <= ${radius * radius}`;
}

function scopedPredicate(region: RegionProbe, filters: SearchFilters = {}): string {
    const filtersSql = filterClause(filters);
    return `${circlePredicate(region)}${filtersSql ? ` AND ${filtersSql.slice(' WHERE '.length)}` : ''}`;
}

function normalizeValue(value: any): any {
    if (typeof value === 'bigint') return Number(value);
    if (Array.isArray(value)) return value.map(normalizeValue);
    if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<unknown>, normalizeValue);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeValue(item)]));
    }
    return value;
}

function normalizeRows(rows: any[]): any[] {
    return rows.map(normalizeValue);
}

/** Browser-side implementation backed by DuckDB-WASM. */
export interface QueryCoordinator {
    query(sql: string): Promise<{ toArray(): any[] }>;
}

export interface ToolExecutorOptions {
    /** Absolute on the server; relative in the browser. */
    analyzerUrl?: string;
    signal?: AbortSignal;
}

/**
 * Shared PAR tool implementation. The browser supplies a Mosaic coordinator;
 * the server runtime supplies a small DuckDB adapter with the same query shape.
 */
export class ToolExecutor {
    private coordinator: QueryCoordinator;
    private analyzerUrl: string;
    private signal?: AbortSignal;

    constructor(coordinator: Pick<Coordinator, 'query'> | QueryCoordinator, options: ToolExecutorOptions = {}) {
        this.coordinator = coordinator;
        this.analyzerUrl = options.analyzerUrl || '/api/analyzer';
        this.signal = options.signal;
    }

    async execute(toolCall: ToolCall): Promise<ToolResult> {
        const { name, arguments: rawArguments } = toolCall.function;
        let args: any;
        try {
            args = JSON.parse(rawArguments || '{}');
        } catch {
            return { name, call_id: toolCall.id, result: null, error: `Invalid JSON arguments: ${rawArguments}` };
        }

        try {
            switch (name) {
                case 'filter_records': return await this.filterRecords(toolCall.id, args);
                case 'scan_projection': return await this.scanProjection(toolCall.id, args);
                case 'inspect_regions': return await this.inspectRegions(toolCall.id, args);
                case 'subdivide_region': return await this.subdivideRegion(toolCall.id, args);
                case 'compare_regions': return await this.compareRegions(toolCall.id, args);
                case 'save_selection': return this.saveSelection(toolCall.id, args.record_ids, args.label);
                default: return { name, call_id: toolCall.id, result: null, error: `Unknown tool: ${name}` };
            }
        } catch (error) {
            return { name, call_id: toolCall.id, result: null, error: error instanceof Error ? error.message : 'Tool execution failed' };
        }
    }

    private async query(sql: string): Promise<any[]> {
        this.signal?.throwIfAborted();
        const result = await this.coordinator.query(sql);
        return normalizeRows(result.toArray());
    }

    private async filterRecords(callId: string, args: SearchFilters & { limit?: number }): Promise<ToolResult> {
        const limit = Math.floor(clamp(args.limit, 15, 1, 50));
        const filters = effectiveFilters(args);
        const where = filterClause(filters);
        const rows = await this.query(`
            SELECT __row_index__, points, description, title, price, variety, country, projection_x, projection_y
            FROM reviews${where}
            ORDER BY points DESC NULLS LAST
            LIMIT ${limit}
        `);
        const countRows = await this.query(`SELECT COUNT(*) AS total FROM reviews${where}`);
        return {
            name: 'filter_records', call_id: callId,
            result: {
                total_matches: Number(countRows[0]?.total || 0),
                matches_returned: rows.length,
                context_applied: appliedContext(args),
                reviews: rows.map(row => ({
                    id: row.__row_index__, points: row.points, title: row.title, price: row.price,
                    variety: row.variety, country: row.country,
                    projection_x: row.projection_x, projection_y: row.projection_y,
                    excerpt: row.description?.length > 300 ? `${row.description.slice(0, 300)}...` : row.description
                }))
            }
        };
    }

    private async scanProjection(callId: string, args: SearchFilters & { grid_size?: number; top_k?: number }): Promise<ToolResult> {
        const gridSize = clamp(args.grid_size, 1, 0.05, 1000);
        const topK = Math.floor(clamp(args.top_k, 12, 1, 30));
        const rows = await this.query(`
            SELECT FLOOR(projection_x / ${gridSize}) AS bin_x,
                   FLOOR(projection_y / ${gridSize}) AS bin_y,
                   COUNT(*) AS density,
                   AVG(points) AS avg_points,
                   AVG(price) AS avg_price
            FROM reviews${filterClause(effectiveFilters(args))}
            GROUP BY bin_x, bin_y
            ORDER BY density DESC, bin_x, bin_y
            LIMIT ${Math.min(120, Math.max(topK * 5, topK))}
        `);
        const candidates = rows.map(row => ({
            bin_x: Number(row.bin_x),
            bin_y: Number(row.bin_y),
            density: Number(row.density),
            avg_points: row.avg_points == null ? null : Number(row.avg_points).toFixed(1),
            avg_price: row.avg_price == null ? null : Number(row.avg_price).toFixed(2)
        }));
        // This is deliberately not a semantic ranking. With no runtime vectors,
        // a scan's job is to expose stable, spatially separated places for the
        // Analyzer to inspect. Density is only a support/reliability signal.
        const selected: typeof candidates = [];
        const minCenterDistance = gridSize * 1.25;
        for (const candidate of candidates) {
            if (selected.some(existing => Math.hypot(
                (existing.bin_x - candidate.bin_x) * gridSize,
                (existing.bin_y - candidate.bin_y) * gridSize
            ) < minCenterDistance)) continue;
            selected.push(candidate);
            if (selected.length === topK) break;
        }
        // Preserve a bounded useful result if the coverage constraint is too
        // restrictive for a sparse filtered subset.
        for (const candidate of candidates) {
            if (selected.length === topK) break;
            if (!selected.includes(candidate)) selected.push(candidate);
        }
        const regions = selected.map((row, index) => ({
            id: `scan-${callId}-${index + 1}`,
            center_x: (row.bin_x + 0.5) * gridSize,
            center_y: (row.bin_y + 0.5) * gridSize,
            // An inscribed circle keeps adjacent scan candidates non-overlapping.
            // Grid density is a ranking signal, not the circle's exact population.
            suggested_radius: gridSize / 2,
            grid_size: gridSize,
            density: row.density,
            avg_points: row.avg_points,
            avg_price: row.avg_price
        }));
        return { name: 'scan_projection', call_id: callId, result: { strategy: 'coverage_first_grid_scan', context_applied: appliedContext(args), regions } };
    }

    private async inspectRegions(callId: string, args: SearchFilters & { regions?: RegionProbe[]; intent?: unknown; sample_size?: unknown }): Promise<ToolResult> {
        const regions = args.regions;
        const intentValue = args.intent;
        const sampleSizeValue = args.sample_size;
        if (!Array.isArray(regions) || regions.length === 0) throw new Error('regions must contain at least one circular probe');
        const probes = regions.slice(0, 8);
        const sampleSize = Math.floor(clamp(sampleSizeValue, 12, 3, 50));
        const intent = String(intentValue || 'Open-ended wine theme discovery').trim().slice(0, 5000);
        const analyses = await Promise.all(probes.map(async (region, index) => {
            try {
                return await this.inspectOneRegion(region, index, sampleSize, intent, args);
            } catch (error) {
                // A single unstable Analyzer response is evidence failure for one
                // circle, not a reason to discard the whole parallel batch.
                return {
                    id: region.id || `probe-${index + 1}`,
                    center_x: finite(region.center_x, 0), center_y: finite(region.center_y, 0),
                    radius: clamp(region.radius, 1, 0.0001, 100000), intent,
                    density: 0, category: 'Analysis failed', themes: [], quotes: [], review_ids: [],
                    purity: 0, purity_rationale: 'The Analyzer request failed before producing usable evidence.',
                    intent_match: 0, intent_match_rationale: 'No structured evidence was returned for this circle.',
                    hard_constraint_match: false, outlier_count: 0, analysis_failed: true,
                    analyzer_status: error instanceof Error ? error.name : 'unknown_error'
                };
            }
        }));
        return { name: 'inspect_regions', call_id: callId, result: { strategy: 'parallel_circular_probes', intent, context_applied: appliedContext(args), regions: analyses } };
    }

    private async inspectOneRegion(region: RegionProbe, index: number, sampleSize: number, intent: string, filters: SearchFilters): Promise<any> {
        const probe = {
            id: region.id || `probe-${index + 1}`,
            center_x: finite(region.center_x, 0),
            center_y: finite(region.center_y, 0),
            radius: clamp(region.radius, 1, 0.0001, 100000)
        };
        const predicate = scopedPredicate(probe, effectiveFilters(filters));
        const countRows = await this.query(`SELECT COUNT(*) AS density FROM reviews WHERE ${predicate}`);
        const rows = await this.query(`
            SELECT __row_index__, points, description, title, price, variety, country, projection_x, projection_y
            FROM reviews WHERE ${predicate}
            ORDER BY hash(__row_index__), __row_index__ LIMIT ${sampleSize}
        `);
        const reviews = rows.map(row => ({
            id: row.__row_index__, points: row.points, title: row.title, price: row.price,
            variety: row.variety, country: row.country, text: row.description,
            projection_x: row.projection_x, projection_y: row.projection_y
        }));
        if (!reviews.length) return {
            ...probe, intent, density: 0, category: 'Empty region', themes: [], review_ids: [], reviews: [],
            purity: 0, purity_rationale: 'The circle contains no sampled reviews.',
            intent_match: 0, intent_match_rationale: 'No evidence is available to match the requested intent.'
        };

        const response = await fetch(this.analyzerUrl, {
            method: 'POST', signal: this.signal, headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ region: probe, intent, reviews })
        });
        if (!response.ok) throw new Error(`Analyzer API returned ${response.status}: ${await response.text()}`);
        const analysis = await response.json();
        return {
            ...analysis, ...probe, intent, density: Number(countRows[0]?.density || 0),
            review_ids: reviews.map(review => review.id),
            sample_size: reviews.length,
            sampling: { method: 'stable_row_hash', seed: 0, sample_ids: reviews.map(review => review.id) },
            reviews
        };
    }

    private async subdivideRegion(callId: string, args: SearchFilters & RegionProbe & { parent_id?: string; subdivisions?: number; top_k?: number }): Promise<ToolResult> {
        const parent: RegionProbe = {
            id: String(args.parent_id || ''),
            center_x: finite(args.center_x, 0), center_y: finite(args.center_y, 0),
            radius: clamp(args.radius, 1, 0.0001, 100000)
        };
        const subdivisions = Math.floor(clamp(args.subdivisions, 4, 2, 10));
        const topK = Math.floor(clamp(args.top_k, 6, 1, 12));
        const cellSize = (parent.radius * 2) / subdivisions;
        const originX = parent.center_x - parent.radius;
        const originY = parent.center_y - parent.radius;
        const rows = await this.query(`
            SELECT FLOOR((projection_x - ${originX}) / ${cellSize}) AS cell_x,
                   FLOOR((projection_y - ${originY}) / ${cellSize}) AS cell_y,
                   COUNT(*) AS density, AVG(points) AS avg_points, AVG(price) AS avg_price,
                   COUNT(DISTINCT variety) AS variety_count, COUNT(DISTINCT country) AS country_count
            FROM reviews
            WHERE ${scopedPredicate(parent, effectiveFilters(args))}
            GROUP BY cell_x, cell_y ORDER BY density DESC, cell_x, cell_y LIMIT ${topK * 3}
        `);
        const children = (await Promise.all(rows.map(async (row, index) => {
            const centerX = originX + (Number(row.cell_x) + 0.5) * cellSize;
            const centerY = originY + (Number(row.cell_y) + 0.5) * cellSize;
            const containedRadius = Math.min(cellSize / 2, parent.radius - Math.hypot(centerX - parent.center_x, centerY - parent.center_y));
            if (containedRadius <= 0.0001) return null;
            const child = {
                id: `subdivision-${callId}-${index + 1}`,
                center_x: centerX,
                center_y: centerY,
                radius: containedRadius,
                suggested_radius: containedRadius
            };
            const predicate = scopedPredicate(child, effectiveFilters(args));
            const dominantVarieties = await this.query(`
                SELECT variety, COUNT(*) AS count FROM reviews
                WHERE ${predicate} AND variety IS NOT NULL
                GROUP BY variety ORDER BY count DESC LIMIT 4
            `);
            const dominantCountries = await this.query(`
                SELECT country, COUNT(*) AS count FROM reviews
                WHERE ${predicate} AND country IS NOT NULL
                GROUP BY country ORDER BY count DESC LIMIT 4
            `);
            return {
                ...child,
                parent_id: parent.id,
                density: Number((await this.query(`SELECT COUNT(*) AS density FROM reviews WHERE ${predicate}`))[0]?.density || 0),
                avg_points: row.avg_points == null ? null : Number(row.avg_points).toFixed(1),
                avg_price: row.avg_price == null ? null : Number(row.avg_price).toFixed(2),
                variety_count: Number(row.variety_count || 0),
                country_count: Number(row.country_count || 0),
                dominant_varieties: dominantVarieties,
                dominant_countries: dominantCountries
            };
        }))).filter((child): child is NonNullable<typeof child> => child !== null && child.density > 0).slice(0, topK);
        return { name: 'subdivide_region', call_id: callId, result: { parent, strategy: 'density_ranked_subdivision', context_applied: appliedContext(args), children } };
    }

    private async compareRegions(callId: string, args: SearchFilters & { regions?: RegionProbe[] }): Promise<ToolResult> {
        const regions = args.regions;
        if (!Array.isArray(regions) || regions.length < 2) throw new Error('compare_regions requires at least two regions');
        const comparisons = await Promise.all(regions.slice(0, 6).map(async (region, index) => {
            const probe = { id: region.id || `region-${index + 1}`, center_x: finite(region.center_x, 0), center_y: finite(region.center_y, 0), radius: clamp(region.radius, 1, 0.0001, 100000) };
            const predicate = scopedPredicate(probe, effectiveFilters(args));
            const [summary] = await this.query(`
                SELECT COUNT(*) AS density, AVG(points) AS avg_points, AVG(price) AS avg_price,
                       MIN(points) AS min_points, MAX(points) AS max_points
                FROM reviews WHERE ${predicate}
            `);
            const categories = await this.query(`
                SELECT country, variety, COUNT(*) AS count FROM reviews
                WHERE ${predicate} GROUP BY country, variety ORDER BY count DESC LIMIT 5
            `);
            return { ...probe, ...summary, dominant_country_varieties: categories };
        }));
        return { name: 'compare_regions', call_id: callId, result: { context_applied: appliedContext(args), regions: comparisons } };
    }

    private saveSelection(callId: string, recordIds: number[], label: string): ToolResult {
        const ids = Array.isArray(recordIds) ? [...new Set(recordIds.map(Number).filter(Number.isFinite))] : [];
        if (!ids.length || !String(label || '').trim()) {
            return { name: 'save_selection', call_id: callId, result: null, error: 'record_ids and label are required' };
        }
        return { name: 'save_selection', call_id: callId, result: { saved: true, count: ids.length, label: String(label).trim(), record_ids: ids } };
    }
}
