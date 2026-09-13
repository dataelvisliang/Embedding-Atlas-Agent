import { actionSchemas, CONTRACT_VERSION, LIMITS, taskSchema } from './searchContract';
import type { ActionName, Candidate, Circle, Evidence, SearchTask, Terminal } from './searchContract';
import type { ToolCall, ToolResult } from '../tools/toolExecutor';

type Executor = { execute(call: ToolCall): Promise<ToolResult> };
type Event = { sequence: number; tool: string; status: 'accepted' | 'completed' | 'blocked' | 'failed'; parameters?: unknown; detail?: string };
export type Bounds = { min_x: number; max_x: number; min_y: number; max_y: number };
const distance = (a: Circle, b: Circle) => Math.hypot(a.center_x - b.center_x, a.center_y - b.center_y);
const sameCircle = (a: Circle, b: Circle) => distance(a, b) <= Math.min(a.radius, b.radius) * .25 && Math.max(a.radius, b.radius) <= Math.min(a.radius, b.radius) * 1.25;
const score = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
const words = (v: string[]) => new Set(v.join(' ').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);

/** One owner for task, candidate provenance, evidence, budgets and terminal state.
 * This class validates agent decisions; it never schedules the next circle. */
export class SearchSession {
    task: SearchTask | null = null;
    terminal: Terminal | null = null;
    readonly results: ToolResult[] = [];
    readonly events: Event[] = [];
    readonly candidates = new Map<string, Candidate>();
    readonly comparisonResults: ToolResult[] = [];
    readonly selectedIds: string[] = [];
    onChange?: () => void;
    readonly limits: typeof LIMITS;
    private scans = new Set<number>();
    private refinements = 0;
    private inspected = 0;
    private actions = 0;
    private failures = 0;
    private lowProgress = 0;
    private tokens = 0;
    private started: number;
    private busy = false;
    private distinctions: string[] = [];
    private explanation = '';
    readonly query: string;
    readonly bounds: Bounds;
    private now: () => number;

    constructor(query: string, bounds: Bounds, limits: Partial<typeof LIMITS> = {}, now = Date.now) {
        this.query = query; this.bounds = bounds; this.now = now;
        this.started = now();
        this.limits = { ...LIMITS, ...limits };
    }

    recordTokens(tokens: number): void { if (Number.isFinite(tokens) && tokens > 0) this.tokens += tokens; }
    end(state: Terminal['state'], reason: string): void {
        if (this.terminal) return;
        this.terminal = { state, reason };
        if (!this.selectedIds.length) this.selectedIds.push(...this.accepted().slice(0, this.task?.target_count || 8).map(c => c.id));
        this.onChange?.();
    }
    checkBudget(): boolean {
        if (!this.terminal && (this.actions >= this.limits.actions || this.tokens >= this.limits.tokens || this.now() - this.started >= this.limits.elapsedMs))
            this.end('budget_exhausted', 'search action, token or elapsed-time budget reached');
        return Boolean(this.terminal);
    }
    private accepted(): Candidate[] { return [...this.candidates.values()].filter(c => c.status === 'accepted'); }
    private available(): Candidate[] {
        return [...this.candidates.values()].filter(c => c.status === 'proposed' || c.status === 'failed' && c.attempts <= this.limits.retries);
    }
    private canRefine(c: Candidate): boolean {
        return c.status === 'frontier' && !c.refined && c.depth < this.limits.depth && this.refinements < this.limits.refinements &&
            this.limits.inspected - this.inspected >= 2 && Boolean(c.evidence && c.evidence.intent_match >= .60 && c.evidence.purity < .70 && c.evidence.hard_constraint_match === true);
    }
    private semanticDuplicate(a: Candidate, b: Candidate): boolean {
        if (!a.evidence || !b.evidence) return false;
        const x = words([a.evidence.category, ...a.evidence.themes]), y = words([b.evidence.category, ...b.evidence.themes]);
        const common = [...x].filter(w => y.has(w)).length;
        const labelEqual = a.evidence.category.trim().toLowerCase() === b.evidence.category.trim().toLowerCase();
        const ids = new Set(b.evidence.review_ids);
        const overlap = a.evidence.review_ids.filter(id => ids.has(id)).length / Math.max(1, Math.min(ids.size, a.evidence.review_ids.length));
        return labelEqual || common / Math.max(1, new Set([...x, ...y]).size) >= .65 || overlap >= .5;
    }
    private event(tool: string, status: Event['status'], parameters?: unknown, detail?: string) {
        this.events.push({ sequence: this.events.length + 1, tool, status, parameters, detail });
        this.onChange?.();
    }
    private deny(tool: string, reason: string): unknown {
        this.event(tool, 'blocked', undefined, reason);
        return { error: reason, session: this.modelState() };
    }

    private defineTask(input: unknown, requireVerbatimSources: boolean): unknown {
        if (this.task) return this.deny('define_task', 'Task is immutable once defined.');
        const parsed = taskSchema.safeParse(input);
        if (!parsed.success) return this.deny('define_task', parsed.error.message);
        const proposed = parsed.data;
        if (requireVerbatimSources) {
            for (const [field, value] of Object.entries(proposed.hard_filters)) {
                if (Array.isArray(value) && !value.length) continue;
                const source = proposed.filter_sources.find(item => item.field === field);
                if (!source || !this.query.toLowerCase().includes(source.quote.toLowerCase()))
                    return this.deny('define_task', `Filter ${field} needs a verbatim source in the original query. Omit unspecified filters entirely.`);
                if (typeof value === 'number' && !(source.quote.match(/\d+(?:\.\d+)?/g) || []).some(n => Number(n) === value))
                    return this.deny('define_task', `Filter ${field}=${value} is not supported by its quoted numeric constraint.`);
                if (Array.isArray(value) && value.some(item => !source.quote.toLowerCase().includes(item.toLowerCase())))
                    return this.deny('define_task', `Every value in filter ${field} must occur in its quoted source. Semantic normalization belongs in a trusted adapter, not the Agent.`);
            }
        }
        this.task = proposed;
        this.event('define_task', 'completed', { ...this.task, source: requireVerbatimSources ? 'agent_compiled' : 'oracle_task_spec' });
        if (this.task.mode === 'exact') this.end('unsupported', 'This endpoint discovers regions; exact record retrieval requires a separate workflow.');
        return { session: this.modelState() };
    }

    /** Seed a separately labelled benchmark annotation without pretending it was
     * compiled verbatim by the product Agent. All later invariants are identical. */
    seedOracleTask(input: unknown): unknown {
        if (this.checkBudget()) return { terminal: this.terminal };
        this.actions++;
        return this.defineTask(input, false);
    }

    async act(name: ActionName, input: unknown, executor: Executor): Promise<unknown> {
        if (this.busy) return this.deny(name, 'Observe the current tool result before another action.');
        if (this.checkBudget()) return { terminal: this.terminal };
        this.actions++;
        const parsed = actionSchemas[name].safeParse(input);
        if (!parsed.success) return this.deny(name, parsed.error.message);
        if (name === 'define_task') return this.defineTask(parsed.data, true);
        if (!this.task) return this.deny(name, 'Define the task before searching.');
        if (name === 'finish_search') return this.finish(actionSchemas.finish_search.parse(parsed.data));
        const data = parsed.data as Record<string, unknown>;
        let args: Record<string, unknown>;
        let requested: Candidate[] = [];
        if (name === 'scan_projection') {
            const grid = data.grid_size as number;
            if (this.scans.has(grid) || this.scans.size >= this.limits.scans) return this.deny(name, 'Duplicate scan scale or scan budget exhausted.');
            if ([...this.candidates.values()].some(c => c.status === 'proposed')) return this.deny(name, 'Inspect existing proposals before scanning again.');
            args = { grid_size: grid, top_k: 16 };
        } else if (name === 'subdivide_region') {
            const c = this.candidates.get(data.parent_id as string);
            if (!c || !this.canRefine(c)) return this.deny(name, 'Parent must be an eligible relevant, mixed inspected circle; check can_refine.');
            requested = [c];
            args = { parent_id: c.id, center_x: c.center_x, center_y: c.center_y, radius: c.radius, subdivisions: 3, top_k: 6 };
        } else {
            const requestedIds = data.region_ids as string[];
            if (new Set(requestedIds).size !== requestedIds.length) return this.deny(name, 'Duplicate region IDs in one batch.');
            for (const id of requestedIds) {
                const c = this.candidates.get(id);
                if (!c) return this.deny(name, `Unknown candidate ID: ${id}`);
                requested.push(c);
            }
            if (name === 'inspect_regions') {
                const available = this.available();
                const remaining = this.limits.inspected - this.inspected;
                if (!remaining) { this.end('budget_exhausted', 'circle inspection budget reached'); return { terminal: this.terminal }; }
                if (requested.some(c => !available.includes(c))) return this.deny(name, 'Circle already inspected or retry limit reached.');
                if (requested.length > remaining) return this.deny(name, `Only ${remaining} circle inspections remain.`);
                if (requested.length < Math.min(3, available.length, remaining)) return this.deny(name, 'Inspect at least three candidates together, or all available if fewer remain.');
                args = { regions: requested.map(c => ({ id: c.id, center_x: c.center_x, center_y: c.center_y, radius: c.radius })), sample_size: 12, intent: this.evidenceIntent() };
            } else {
                if (requested.some(c => c.status !== 'accepted')) return this.deny(name, 'Compare accepted evidence only.');
                const key = requestedIds.slice().sort().join('|');
                if (this.comparisonResults.some(r => r.result?.comparison_key === key)) return this.deny(name, 'This comparison was already completed.');
                args = { regions: requested.map(c => ({ id: c.id, center_x: c.center_x, center_y: c.center_y, radius: c.radius })) };
            }
        }
        args.search_context = { version: 1, hard_filters: this.task.hard_filters, semantic_intent: this.evidenceIntent() };
        this.event(name, 'accepted', { ...data, ...args });
        const call: ToolCall = { id: `action-${this.actions}`, type: 'function', function: { name, arguments: JSON.stringify(args) } };
        this.busy = true;
        let result: ToolResult;
        try { result = await executor.execute(call); }
        catch (e) { result = { name, call_id: call.id, result: null, error: e instanceof Error ? e.message : String(e) }; }
        finally { this.busy = false; }
        if (this.terminal) return { terminal: this.terminal }; // Never commit late responses after cancellation.
        this.results.push(result);
        if (result.error) {
            this.event(name, 'failed', undefined, result.error);
            this.end('runtime_error', `${name} could not produce evidence: ${result.error}`);
            return { terminal: this.terminal };
        }
        if (name === 'scan_projection') {
            this.scans.add(data.grid_size as number);
            this.register(result.result?.regions);
        } else if (name === 'subdivide_region') {
            requested[0].refined = true; this.refinements++;
            this.register(result.result?.children, requested[0]);
        } else if (name === 'inspect_regions') {
            this.inspected += requested.length;
            const before = this.accepted().length;
            let validCount = 0;
            for (const c of requested) {
                c.attempts++;
                const raw = (result.result?.regions || []).find((r: { id: string }) => r.id === c.id);
                this.recordTokens(Number(raw?.analyzer_usage?.total_tokens) || 0);
                if (this.assess(c, raw)) validCount++;
            }
            // Failure batches carry no negative semantic evidence.
            if (validCount === requested.length) this.lowProgress = this.accepted().length > before || requested.some(c => this.canRefine(c)) ? 0 : this.lowProgress + 1;
            if (requested.every(c => c.status === 'failed' && c.attempts > this.limits.retries))
                this.end('runtime_error', 'All circles in this batch failed after the bounded retry.');
        } else {
            result.result.comparison_key = requested.map(c => c.id).sort().join('|');
            this.comparisonResults.push(result);
        }
        this.event(name, 'completed');
        this.checkBudget();
        return { observation: name === 'compare_regions' ? result.result : undefined, session: this.modelState() };
    }

    private evidenceIntent(): string {
        return `Original request (global search goal): ${this.query}\nEvaluate this circle as ONE finding: ${this.task?.finding_unit}\nLocal relevance requirements: ${this.task?.evidence_requirements.join('; ')}\nHard metadata filters: ${JSON.stringify(this.task?.hard_filters)}\nDo not penalize this circle for failing to contain the requested number of different findings. Count and inter-region diversity are handled by the main agent.`;
    }
    private register(rows: unknown, parent?: Candidate): void {
        if (!Array.isArray(rows)) throw new Error('Spatial tool did not return a candidate array');
        for (const r of rows) {
            const c: Candidate = { id: String(r.id || ''), center_x: r.center_x, center_y: r.center_y, radius: r.radius ?? r.suggested_radius,
                depth: parent ? parent.depth + 1 : 0, parent_id: parent?.id, population: Number.isFinite(r.density) ? r.density : null,
                status: 'proposed', attempts: 0, refined: false, acceptance_tier: null };
            if (!c.id || ![c.center_x, c.center_y, c.radius].every(Number.isFinite) || c.radius <= 0) continue;
            if (parent && (c.radius >= parent.radius || distance(c, parent) + c.radius > parent.radius + 1e-7)) continue;
            if ([...this.candidates.values()].some(existing => sameCircle(c, existing))) continue;
            if (this.candidates.has(c.id)) continue;
            this.candidates.set(c.id, c);
        }
    }
    private assess(c: Candidate, raw: Record<string, unknown> | undefined): boolean {
        const reviews = Array.isArray(raw?.reviews) ? raw.reviews : [];
        const reviewIds = [...new Set(reviews.map((r: { id?: number }) => r.id).filter((id): id is number => Number.isSafeInteger(id)))];
        const f = this.task!.hard_filters;
        const scopeMismatch = reviews.some((r: Record<string, unknown>) =>
            f.countries?.length && !f.countries.includes(String(r.country)) ||
            f.varieties?.length && !f.varieties.includes(String(r.variety)) ||
            Object.entries({ min_price: f.min_price, max_price: f.max_price, min_points: f.min_points, max_points: f.max_points }).some(([key, limit]) => {
                if (limit === undefined) return false;
                const value = r[key.endsWith('price') ? 'price' : 'points'];
                return typeof value !== 'number' || !Number.isFinite(value) || (key.startsWith('min') ? value < limit : value > limit);
            }));
        if (scopeMismatch) { c.status = 'failed'; c.error = 'sample_scope_mismatch'; this.failures++; return false; }
        const failed = !raw || raw.analysis_failed || !score(raw.purity) || !score(raw.intent_match) ||
            !(raw.hard_constraint_match === true || raw.hard_constraint_match === false) || reviewIds.length < 3;
        if (failed) {
            if (raw?.density === 0 && !raw?.analysis_failed) { c.status = 'rejected'; c.error = 'empty circle'; return true; }
            c.status = 'failed'; c.error = String(raw?.analyzer_status || 'invalid or insufficient evidence'); this.failures++; return false;
        }
        const e: Evidence = { category: String(raw.category || ''), themes: strings(raw.themes), quotes: strings(raw.quotes),
            purity: raw.purity as number, intent_match: raw.intent_match as number, hard_constraint_match: raw.hard_constraint_match as boolean,
            sample_size: reviewIds.length, review_ids: reviewIds, purity_rationale: String(raw.purity_rationale || ''), intent_match_rationale: String(raw.intent_match_rationale || '') };
        c.evidence = e; c.error = undefined;
        const duplicate = this.accepted().some(other => other.id !== c.id && this.semanticDuplicate(c, other));
        c.acceptance_tier = !e.hard_constraint_match || !e.category.trim() ? null :
            e.purity >= .70 && e.intent_match >= .75 ? 'strong' :
                e.purity >= .75 && e.intent_match >= .65 ? 'soft' :
                    this.task?.mode === 'exploration' && !duplicate && e.purity >= .70 && e.intent_match >= .60 ? 'diversity' : null;
        c.status = c.acceptance_tier && !(this.task?.require_diversity && duplicate) ? 'accepted' :
            e.hard_constraint_match && e.intent_match >= .60 ? 'frontier' : 'rejected';
        if (duplicate) c.error = 'duplicate evidence/theme heuristic; not counted as a distinct finding';
        return true;
    }
    private finish(data: { reason: string; finding_ids: string[]; explanation: string; distinctions: string[] }): unknown {
        const ids = data.finding_ids;
        if (new Set(ids).size !== ids.length || ids.some(id => this.candidates.get(id)?.status !== 'accepted')) return this.deny('finish_search', 'Each finding ID must refer to distinct accepted evidence.');
        const sufficient = ids.length >= this.task!.target_count;
        if (data.reason === 'sufficient_evidence' && !sufficient) return this.deny('finish_search', 'Requested target has not been met.');
        if (this.task!.require_diversity && ids.length > 1 && data.distinctions.length !== ids.length) return this.deny('finish_search', 'Give one evidence-based distinction per selected finding.');
        if (this.task!.mode === 'comparison' && sufficient && !this.comparisonResults.some(r => ids.every(id => r.result.comparison_key.split('|').includes(id)))) return this.deny('finish_search', 'Compare the selected findings before claiming comparison success.');
        if (!sufficient) {
            if (this.accepted().length >= this.task!.target_count) return this.deny('finish_search', 'Enough accepted evidence exists; select it before stopping.');
            if ([...this.candidates.values()].some(c => this.canRefine(c))) return this.deny('finish_search', 'An actionable relevant mixed frontier remains.');
            if (!this.scans.size) return this.deny('finish_search', 'No spatial evidence has been collected.');
            if (data.reason === 'diminishing_returns' && this.lowProgress < 2) return this.deny('finish_search', 'Two complete valid low-progress batches are required.');
            if (data.reason === 'candidates_exhausted' && (this.available().length || this.scans.size < this.limits.scans)) return this.deny('finish_search', 'Generated candidate actions or another scan scale remain.');
            if (data.reason === 'sufficient_evidence') return this.deny('finish_search', 'Insufficient evidence.');
        }
        this.selectedIds.push(...ids); this.distinctions = data.distinctions; this.explanation = data.explanation;
        this.event('finish_search', 'completed', data);
        const unresolvedFailures = [...this.candidates.values()].some(c => c.status === 'failed');
        this.end(sufficient ? 'success' : unresolvedFailures ? 'runtime_error' : ids.length ? 'partial_success' : 'no_evidence', data.reason);
        return { terminal: this.terminal };
    }
    modelState() {
        return { contract: CONTRACT_VERSION, bounds: this.bounds, task: this.task, terminal: this.terminal,
            remaining: { actions: this.limits.actions - this.actions, scans: this.limits.scans - this.scans.size, circles: this.limits.inspected - this.inspected, tokens: this.limits.tokens - this.tokens },
            low_progress_batches: this.lowProgress,
            candidates: [...this.candidates.values()].map(c => ({
                id: c.id, xy: [c.center_x, c.center_y], radius: c.radius, parent_id: c.parent_id,
                status: c.status, population: c.population, can_refine: this.canRefine(c),
                retry_available: c.status === 'failed' && c.attempts <= this.limits.retries,
                category: c.evidence?.category, purity: c.evidence?.purity, intent_match: c.evidence?.intent_match,
                constraint_match: c.evidence?.hard_constraint_match,
                themes: c.status === 'rejected' ? undefined : c.evidence?.themes,
                rationale: c.status === 'frontier' || c.status === 'accepted' ? c.evidence?.intent_match_rationale.slice(0, 200) : undefined,
                error: c.error
            })) };
    }
    snapshot() {
        return { contract: CONTRACT_VERSION, task: this.task, terminal: this.terminal, must_stop: Boolean(this.terminal), stop_reason: this.terminal?.reason || null,
            objective: { target_accepted_regions: this.task?.target_count || 0 },
            inspected_region_count: this.inspected, accepted_region_count: this.accepted().length,
            relevant_themes: this.accepted().flatMap(c => c.evidence?.themes || []),
            frontier: [...this.candidates.values()].filter(c => c.status === 'frontier'),
            candidates: [...this.candidates.values()].map(c => ({ ...c, ...c.evidence, recommended_action: c.status === 'accepted' ? 'accept' : c.status === 'rejected' ? 'reject' : c.status, analysis_failed: c.status === 'failed' })),
            remaining: { toolCalls: Math.max(0, this.limits.actions - this.actions), modelTokens: Math.max(0, this.limits.tokens - this.tokens) },
            elapsed_ms: this.now() - this.started, no_progress_rounds: this.lowProgress, failure_attempts: this.failures,
            trajectory: [...this.events], selected_ids: [...this.selectedIds] };
    }
    answer(): string {
        if (!this.terminal) throw new Error('Cannot answer before terminal state');
        const lines = this.selectedIds.map((id, i) => {
            const e = this.candidates.get(id)?.evidence;
            if (!e) return '';
            return `${i + 1}. ${e.category} [${id}] — purity ${e.purity.toFixed(2)}, intent ${e.intent_match.toFixed(2)}. ${e.intent_match_rationale} ${this.distinctions[i] || ''}`;
        });
        return [`Search result: ${this.terminal.state}. ${this.explanation || this.terminal.reason}`, ...lines,
            lines.length ? '{{Verified projection findings}}' : 'No verified matching regions were obtained.',
            'Scores describe the sampled evidence, not every record in a circle.'].join('\n\n');
    }
    presentation(): ToolResult | null {
        if (!this.terminal) throw new Error('Presentation requires terminal state');
        const ids = [...new Set(this.selectedIds.flatMap(id => this.candidates.get(id)?.evidence?.review_ids || []))];
        return ids.length ? { name: 'save_selection', call_id: 'presentation', result: { saved: true, label: 'Verified projection findings', record_ids: ids, controller_generated: true } } : null;
    }
}
export type SearchPolicySnapshot = ReturnType<SearchSession['snapshot']>;
