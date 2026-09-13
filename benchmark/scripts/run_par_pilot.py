"""Compatibility entry point for the retired PAR v1 pilot.

The executable PAR v3 pilot shares the production Agents SDK runtime and lives
in ``run_sdk_par_pilot.ts``. Keeping this small failure-fast shim prevents old
commands from silently producing results under an obsolete search contract.
"""

raise SystemExit(
    "Historical PAR v1 runner retired. From web-app run: "
    "npm exec -- tsx ../benchmark/scripts/run_sdk_par_pilot.ts"
)
