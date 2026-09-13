# PAR Agent v3 development gate

Recorded 2026-09-12 (America/Toronto). Implementation: main Agent selects actions through the official Agents SDK; one SearchSession owns contract state. Runtime uses XY, metadata and fixed text samples without embedding retrieval.

## Final live gate

Source: `benchmark/runs/sdk-pilot/sdk_par_pilot_20260913T000354764Z.jsonl` and its companion `.trace.jsonl`. All queries used `agent_compiled` tasks, the same input path as chat; no oracle benchmark annotations were supplied.

| Query | Terminal | Selected / target | Accepted pool | Reported tokens | Latency |
| --- | --- | --- | --- | --- | --- |
| wine-dev-005 | success | 3 / 3 | 7 | 60,569 | 36.186 s |
| wine-dev-006 | success | 3 / 3 | 5 | 65,227 | 58.542 s |
| wine-dev-010 | success | 4 / 4 | 4 | 78,317 | 51.627 s |

- 005: define task -> scan -> two batch inspections -> compare -> finish.
- 006: define task -> scan -> inspect -> subdivide -> inspect -> subdivide -> inspect -> finish.
- 010: define task -> scan -> two batch inspections -> subdivide -> inspect -> finish.

006 retained two failed candidate analyses separately from rejected candidates. It still met the target with other verified evidence. The presenter selected findings only after terminal completion. No Agent-driven save loop exists.

## Contract corrections discovered by live testing

1. The model invented `max_points: 0` for an unspecified constraint, yielding empty scans. Task definition now requires original-query source quotes for every actual hard filter and validates numeric values against those quotes.
2. Analyzer confused global target count with per-circle relevance: a pure single-style circle could be penalized for not containing three styles. The contract now has `finding_unit` and explicitly separates local evidence from global count/diversity.
3. Repeated full state descriptions inflated model context. Model observations now carry compact state; full evidence remains in traces/UI results.

These were contract changes, not query-specific threshold changes. Acceptance cutoffs were unchanged during the final three-query gate.

## Offline verification

`searchContract.test.ts`: actual SDK schema construction; valid one-batch completion; candidate provenance; immutable sourced constraints; minimum batch; successful-sample deduplication; refinement and child containment; unknown-constraint handling; scope mismatch detection; bounded analysis retry; distinctness heuristic; comparison-before-success; budget/terminal behavior; explicit unsupported mode.

`toolExecutor.test.ts`: one failed circle does not erase successful peers in the batch. TypeScript API/runner checks and production frontend build passed. Post-gate hardening added sample-scope integrity checks, SDK schema-conversion regression coverage and earlier trace checkpoints; the offline suite was rerun after these changes.

## Limits of this evidence

This is one successful live run per query, not a statistical stability claim. 010 is close to the 80k observed-token budget. Failed requests may consume unreported usage; USD cost is unavailable, not zero. Analyzer relevance/purity and heuristic theme deduplication still require human annotation. These results establish executable Agent-driven circle/refinement behavior, not retrieval superiority.

Exact record retrieval and selected-map-subset adapters are explicitly unsupported by this region endpoint. No full-map search is silently substituted for a selected subset. Deployment was not tested or published.

Next experimental step: freeze contract/data/model versions, repeat the dev gate, then begin blinded relevance/distinctness annotation and spatial baseline comparison without changing acceptance thresholds to fit labels.
