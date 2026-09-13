# Annotation artifacts

`par_agent_v3_dev_blind_pool.jsonl` contains query text, explicit constraints and fixed review samples only. It intentionally excludes system identity, rank, Agent decisions, Analyzer labels and Analyzer scores. Do not distribute the companion `.sources.json` until an annotation pass is complete.

`par_agent_v3_dev_codex_assisted.jsonl` is a complete first-pass, model-assisted review of the blind pool. It is labelled `codex-assisted-1` and must not be represented as independent human ground truth. A second human annotator should label a separately shuffled copy of the blind pool without reading this file or the hidden sources. Disagreements follow `ANNOTATION_GUIDE.md` adjudication rules.

`par_agent_v3_dev_subagent_assisted_2.jsonl` is a second complete AI-assisted pass produced in a context-isolated subagent. The subagent read only the annotation guide and blind pool. This is useful for measuring provisional consistency, but context isolation does not turn an AI reviewer into a human annotator.

Rebuild the blind pool from the committed SDK gate without another LLM call:

```powershell
cd web-app
npm exec -- tsx ../benchmark/scripts/prepare_sdk_blind_pool.ts `
  --run benchmark/runs/sdk-pilot/sdk_par_pilot_20260913T000354764Z.jsonl `
  --output benchmark/annotations/par_agent_v3_dev_blind_pool.jsonl
```

The script reconstructs the exact 12-record samples using the recorded circle geometry, compiled hard filters and `ORDER BY hash(__row_index__), __row_index__`.
