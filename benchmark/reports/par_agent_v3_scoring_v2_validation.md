# PAR Agent v3 per-item scoring validation

## Change under test

Analyzer no longer emits holistic purity and intent scores. It returns two typed arrays in input order: dominant-theme membership and 0/1/2 intent relevance. The server rejects wrong lengths, binds trusted review IDs by index and deterministically calculates both scores. A hard session boundary also blocks additional retrieval after the accepted target is met.

## Live runtime gate

| Query | Terminal | Sequence | Failed analyses | Tokens | Latency |
| --- | --- | --- | ---: | ---: | ---: |
| wine-dev-005 | success | scan → inspect → subdivide → inspect → finish | 0 | 67,704 | 23.665 s |
| wine-dev-006 | success | scan → inspect → finish | 0 | 31,705 | 21.067 s |
| wine-dev-010 | success | scan → inspect → inspect → inspect → finish | 0 | 62,997 | 37.920 s |

The fixed-array contract eliminated duplicated/invented ID failures observed with per-item objects. The stop boundary prevented the prior 010 failure where the Agent continued refining after enough accepted evidence and exhausted its budget.

## Blind reviewer validation

An isolated reviewer labelled the reconstructed fixed samples without model scores, generated categories, decisions or provenance. Reviewer artifact: `annotations/par_agent_v3_scoring_v2_subagent_validation.jsonl`.

| Query | Runtime accepted / target | Reviewer acceptable / target | Reviewer outcome |
| --- | ---: | ---: | --- |
| wine-dev-005 | 3 / 3 | 2 / 3 | target not met |
| wine-dev-006 | 3 / 3 | 1 / 3 | target not met |
| wine-dev-010 | 4 / 4 | 2 / 4 | target not met |

Across the ten selected regions, Analyzer-to-reviewer purity MAE is 0.162 and intent-match MAE is 0.080. The model accepted all ten; the reviewer accepted five. Runtime integration therefore passes, but semantic success does not.

## Diagnosis

Deterministic aggregation fixes auditability and arithmetic, not classifier quality. GLM-5.3-Flash still chooses umbrella themes and then marks heterogeneous samples as members. It also overstates relative value for some high-priced or modest-quality regions. Lowering thresholds would worsen false positives; raising thresholds would discard reviewer-accepted borderline regions and would not reliably repair the ranking.

The next controlled experiment should keep the fixed-array contract and thresholds constant while changing only the Analyzer condition: stronger model versus two-pass conservative consensus. Do not run the full benchmark until one condition reaches acceptable blind region agreement on development data.
