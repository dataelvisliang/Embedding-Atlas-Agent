# PAR search contract v3

Version: `par-agent-v3`. This replaces the old free-planner/SearchPolicy pair and the deterministic circle scheduler. The original strategy is preserved: the main Agent scans a map, chooses several circles, observes purity/intent evidence, and chooses further exploration, subdivision or termination.

## Ownership

- `searchContract.ts`: single executable source of input schemas, limits and planner instructions.
- `SearchSession`: sole owner of task, candidate provenance, evidence eligibility, budgets and terminal state. It validates decisions; it does not choose circles.
- OpenAI Agents SDK: owns model/tool turns. Main Agent selects actions and candidates. The SDK tool completion callback stops the run only when the session is terminal.
- `ToolExecutor`: SQL over XY, metadata and text samples. No runtime vectors or embedding service.
- Analyzer: scores actual samples, including price/country/variety/points and original intent. One attempt per inspection; the session permits one failed-circle retry.
- Presenter: one result selection after termination, derived from sampled record IDs. It is not an Agent tool.

## Six Agent tools

| Tool | Inputs | Contract |
| --- | --- | --- |
| define_task | mode, target_count, finding_unit, require_diversity, hard_filters, filter_sources, evidence_requirements | Once, before retrieval; immutable thereafter |
| scan_projection | grid_size, reason | Proposes spatial circles; cannot interpret semantics; two distinct scales maximum |
| inspect_regions | region_ids, reason | 3–8 proposals together, or all eligible when fewer than 3 remain; exact geometry and scope injected |
| subdivide_region | parent_id, reason | Parent has relevant mixed evidence; contained smaller children; at most depth 2 and one subdivision per parent |
| compare_regions | region_ids, reason | Accepted inspected evidence only; must precede comparison success |
| finish_search | reason, finding_ids, explanation, distinctions | Session verifies the target or grounds for partial completion; then all further actions are forbidden |

Generic tool names do not imply arbitrary-dataset adapters: the current SQL metadata adapter still supports wine country, variety, price and points. Color and semantic constraints must remain in `evidence_requirements` and are judged from sample evidence. Do not invent literal keyword filters for flavors. Original query always reaches Analyzer, even with an oracle TaskSpec.

Every Agent-compiled SQL filter requires a verbatim source quote. Numeric values and every country/variety value must occur in that quote; semantic normalization belongs in a trusted adapter, not model improvisation. Unspecified constraints are omitted, never represented by zero. This checks provenance, not the full semantic correctness of task compilation; the generated task remains part of evaluation. A benchmark oracle task enters only through the in-process pilot runner's separately labelled seed method and then obeys the same retrieval, evidence and terminal invariants. The public API does not accept oracle TaskSpecs.

`finding_unit` defines ONE style/theme/region. `target_count` and between-region diversity belong to the whole session. Analyzer must not lower a pure single-style circle's relevance because the user wants multiple styles overall, or reward a mixed circle for containing the entire requested count.

`exact` record requests return `unsupported`; this region workflow must not silently substitute region counts for record counts. Semantic, exploration and comparison return regions. Map-selection scoping requires an explicit separate scope adapter and must not silently search the whole map.

## Evidence states and decisions

Proposed -> accepted / frontier / rejected / failed. Failed is unknown, never a semantic rejection, never negative progress. Valid evidence needs at least 3 distinct sampled IDs, numeric scores in [0,1], a category and an explicit constraint judgment. IDs come from the SQL sample, never from generated text.

- Strong: purity >= .70 and intent >= .75.
- Soft: purity >= .75 and intent >= .65.
- Diversity: exploration only, purity >= .70 and intent >= .60, with no detected duplicate.
- All accepts require constraint_match=true.
- Refinement: frontier with intent >= .60 and purity < .70, constraint_match=true, sufficient depth/action/circle budget.
- Semantic duplication uses matching labels, token-set similarity or sampled-ID overlap. This is a conservative heuristic, not proof of semantic distinctness; the Agent supplies distinctions and human benchmark judgments assess them.

Sampling is fixed by hash(row ID), with row ID as a tie-breaker. Pin dataset and DuckDB version for replay. LLM output remains nondeterministic. A fixed sample does not constitute a confidence interval or validation of every row in the circle.

## Termination

One `terminal` object feeds API, UI and pilot. Terminal is absorbing.

- success: selected accepted findings reach target; diversity explanations present when required; comparison completed when required.
- partial_success / no_evidence: fewer findings and either generated actions exhausted or two complete valid low-progress batches. An actionable refinement prevents early partial stop.
- budget_exhausted: action, token, circle or wall-time budget/cancellation.
- runtime_error: infrastructure failures, unrecoverable analysis or illegal premature model final.
- unsupported: exact record workflow is outside this endpoint.

Unknown/failed analysis cannot justify `no_evidence`. Exhaustion refers to generated proposals and permitted scan scales, never proof that the dataset contains no answer. Reaching a budget with useful findings preserves those findings and the budget terminal.

Token limits are checked against returned usage. A running model request/batch may overshoot the limit before its usage is known; it prevents subsequent actions, not charges already incurred. Failure responses can have unreported usage. Live output must not imply these are exact billing totals.

## Evaluation contract

Offline tests assert invalid-ID rejection, batch size, immutable scope, refinement containment/provenance, failure/retry separation, diversity count, comparison-before-success and absorbing terminal states. Tests allow different Agent strategies and successful one-batch completion.

Live pilot uses the same query-to-define_task path as chat by default. `--oracle-task-spec` is a separately labeled experimental condition, not the product gate. Do not compare these conditions as if their input information were identical.

Record contract validity separately from task success and relevance quality. Preserve incremental `.trace.jsonl` snapshots, generated task, accepted/rejected/frontier/failed, terminal, final answer, token counts and latency. Monetary cost stays null unless provider-reported pricing is available. Live pilot establishes integration behavior; it does not establish PAR superiority or annotation quality.
