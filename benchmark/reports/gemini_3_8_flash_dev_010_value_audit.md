# Gemini 3.8 Flash: value-query audit

## Conditions

Both the Main Agent and Analyzer used `google/gemini-3.8-flash`. The retrieval contract remained projection XY, metadata and fixed text samples only; no embedding or vector runtime was introduced.

The first full-stack run compiled unbounded “good value” as requiring literal `bargain` or `good value` wording. Its blind inspected-pool audit covered 32 circles. The reviewer found 6 acceptable wine-dev-010 circles among the 16 inspected, while the runtime accepted none. This was a task-compilation error, not evidence that the projection contained no value regions.

The contract now defines unbounded value comparatively: sampled price together with points and review quality; literal value language is optional corroboration and no numeric cutoff is invented. It also reserves a bounded finalization allowance before an inspection batch, so a run can return an explainable partial result instead of spending its final tokens on a batch and ending without `finish_search`.

## Corrected live run

`sdk_par_pilot_20260913T012159040Z.jsonl` completed wine-dev-010 with:

| Terminal | Sequence | Accepted | Failed analysis | Tokens | Latency |
| --- | --- | ---: | ---: | ---: | ---: |
| success | scan → inspect → subdivide → inspect → finish | 5 (4 selected) | 0 | 54,033 | 23.745 s |

## Independent blind selected-region review

The context-isolated reviewer saw only the query and reconstructed fixed samples, not model scores, decisions, coordinates, trace, source file or reports. Its artifact is `annotations/gemini_3_8_flash_010_final_selected_subagent_validation.jsonl`; it contains 52 exact units (48 items and 4 regions). This is AI-assisted review, not human ground truth.

| Selected category | Model purity / intent | Reviewer purity / intent | Reviewer acceptable under existing tier rules |
| --- | ---: | ---: | --- |
| Global Riesling | .92 / .79 | .91 / .74 | yes (soft) |
| Australian Shiraz | .92 / .67 | .94 / .66 | yes (soft) |
| Sicilian Nero d’Avola | .92 / .88 | .92 / .82 | yes (strong) |
| Piedmont Red Wines | .83 / .67 | .92 / .48 | no |

Selection-level purity MAE is .03 and intent-match MAE is .08. Reviewer agreement is 3/4 selected regions. The remaining false positive is value-specific: the Piedmont region is coherent but its sampled premium and unpriced wines do not support value.

## Decision

The corrected value semantics eliminate the prior catastrophic false-negative outcome and the runtime completes the intended Agentic workflow. It is not yet a formal benchmark pass: 010 still has one value false positive, and this review is AI-assisted. Keep the contract and thresholds fixed, collect two independent human annotations on the selected pools, then evaluate the held-out test split without further prompt tuning.
