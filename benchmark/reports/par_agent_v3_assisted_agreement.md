# PAR Agent v3 assisted inter-reviewer agreement

Two complete blind passes cover the same 120 item and 10 region units:

- `codex-assisted-1`
- `subagent-assisted-2`

The second reviewer was started without conversation history and was instructed to read only the annotation guide and blind pool. It did not read the first labels, hidden sources, runs, reports or implementation. Both reviewers are AI-assisted and therefore do not satisfy the benchmark requirement for two independent human annotators.

## Agreement

| Measure | Result |
| --- | ---: |
| Item exact relevance agreement | 87.5% |
| Item Cohen's kappa | 0.737 |
| Item quadratic-weighted kappa | 0.847 |
| Region purity MAE | 0.059 |
| Region intent-match MAE | 0.061 |
| Region threshold accept/reject agreement | 8 / 10 |
| Item disagreements larger than one grade | 0 |
| Region score disagreements larger than 0.30 | 0 |

The 15 item disagreements are all adjacent grades (`0↔1` or `1↔2`). Most concern whether marginally priced wines count as good value, or whether a fruit-forward Syrah with one smoke/meat note is partially or directly savory.

## Threshold-sensitive regions

| Query | Region | Reviewer 1 | Reviewer 2 | Source of disagreement |
| --- | --- | --- | --- | --- |
| wine-dev-005 | region-a0f57cbb08d9 | 0.66 purity / 0.86 intent: reject | 0.72 / 0.94: accept | Eight Prosecco/Glera samples plus four still Portuguese whites; whether 8/12 is enough for 0.70 purity |
| wine-dev-006 | region-8128aff5970c | 0.87 / 0.59: reject | 0.91 / 0.73: accept | Varietally coherent Syrah, but several samples are sweet, jammy, hot or oaky rather than unusual and savory |

Acceptance uses the exploration floor of purity >= 0.70 and intent >= 0.60. These two cases cross a threshold despite small continuous-score differences, so they should be adjudicated even though they do not trigger the guide's >0.30 rule.

## Query outcome robustness

| Query | Runtime claim | Reviewer 1 acceptable | Reviewer 2 acceptable | Interpretation |
| --- | ---: | ---: | ---: | --- |
| wine-dev-005 | 3 / 3 success | 1 / 3 | 2 / 3 | target missed under both reviews |
| wine-dev-006 | 3 / 3 success | 2 / 3 | 3 / 3 | success depends on Syrah adjudication |
| wine-dev-010 | 4 / 4 success | 3 / 4 | 3 / 4 | target missed under both reviews |

The robust development finding is therefore not that all three searches failed. It is that two runtime successes (`005`, `010`) are false-positive successes under both blind assisted reviews, while `006` remains threshold-sensitive. Human review is required before changing the Analyzer, geometry or acceptance policy.
