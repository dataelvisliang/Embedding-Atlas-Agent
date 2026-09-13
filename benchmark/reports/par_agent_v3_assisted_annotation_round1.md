# PAR Agent v3 assisted annotation — round 1

This is a complete blinded first pass over the three-query development gate: 120 item judgments and 10 region judgments. Reviewer ID: `codex-assisted-1`. The reviewer saw query text, explicit constraints and raw fixed samples, but not system provenance, Agent decisions, generated categories, purity, intent match or acceptance state.

This is model-assisted review, not independent human ground truth. Do not tune the system or make paper claims until an independently blinded second annotator and adjudication are complete.

## Region-level results after reveal

| Query | Selected region | Assisted purity | Analyzer purity | Assisted intent | Analyzer intent | Assisted acceptance |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| wine-dev-005 | scan-action-2-1 | 0.54 | 0.85 | 0.62 | 0.85 | no |
| wine-dev-005 | scan-action-2-5 | 0.88 | 0.95 | 0.86 | 0.90 | strong |
| wine-dev-005 | scan-action-2-7 | 0.66 | 0.75 | 0.86 | 0.90 | no |
| wine-dev-006 | scan-action-2-6 | 0.75 | 0.90 | 0.79 | 0.85 | strong |
| wine-dev-006 | scan-action-2-15 | 0.87 | 0.80 | 0.59 | 0.70 | no |
| wine-dev-006 | subdivision-action-4-1 | 0.82 | 0.90 | 0.90 | 0.90 | strong |
| wine-dev-010 | scan-action-2-4 | 0.63 | 0.75 | 0.78 | 0.70 | no |
| wine-dev-010 | scan-action-2-6 | 0.90 | 0.85 | 0.76 | 0.75 | strong |
| wine-dev-010 | scan-action-2-10 | 0.88 | 0.92 | 0.78 | 0.72 | strong |
| wine-dev-010 | subdivision-action-5-2 | 0.91 | 0.90 | 0.91 | 0.75 | strong |

Acceptance above reapplies the committed strong/soft/diversity thresholds to the assisted scores. The diversity tier does not rescue the failed regions because their purity or intent remains below its floor.

| Query | Runtime selected / target | Assisted acceptable / target | Provisional outcome |
| --- | ---: | ---: | --- |
| wine-dev-005 | 3 / 3 | 1 / 3 | target not met |
| wine-dev-006 | 3 / 3 | 2 / 3 | target not met |
| wine-dev-010 | 4 / 4 | 3 / 4 | target not met |

## Error patterns to adjudicate

1. **Umbrella-theme purity inflation.** A circle of unrelated white varieties was treated as a coherent crisp-white style even though oxidized, dessert-sweet, barrel-influenced and low-acid samples were present (purity delta +0.31).
2. **Variety purity confused with query relevance.** The Syrah circle was varietally coherent, but several samples were jammy, sweet or heavily oaked rather than unusual and savory (intent delta +0.11).
3. **Mixed substyle accepted as one finding.** The Prosecco region contained eight Prosecco/Glera samples and four still Portuguese whites; its intent was high, but its single-theme purity fell below the acceptance floor.
4. **Value remains inherently relative.** The assisted reviewer used price, score and review quality together rather than inventing a fixed price threshold. These judgments deserve focused human adjudication.

## Next gate

Freeze these files. Give a shuffled blind pool to a second annotator. Compute item agreement, region-score deltas and threshold-level accept/reject agreement. Adjudicate relevance differences greater than one grade and region-score differences greater than 0.30. Only then decide whether the defect is Analyzer calibration, candidate geometry, finding-unit definition or the acceptance policy.

Post-review implementation direction: replace holistic model-generated purity/intent numbers with auditable per-item dominant-theme membership and 0/1/2 relevance labels, then aggregate scores deterministically. This is a generic scoring-contract correction; the assisted labels themselves are not inserted into the runtime prompt.
