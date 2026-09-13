# Remaining research and product work

Current implementation and acceptance rules are defined in [PAR contract v3](PROJECTION_AGENT_SEARCH.md).

- Validate live dev queries on the same task-compilation path as chat; separately label oracle task inputs.
- Human-annotate region relevance and distinctness. Analyzer scores and label deduplication are not ground truth.
- Compare fixed-grid, density-first, random spatial exploration and adaptive Agent search under equal sample and token budgets.
- Measure semantic coverage, duplicate findings, tool/sample efficiency, latency and actual provider cost.
- Build explicit exact-record and selected-map-subset adapters before advertising those workflows through the region endpoint.
- Add another dataset adapter and test scales/projection parameters without introducing runtime embeddings.
