# HALO traces for pi

Records pi agent, LLM-turn, and tool spans to a local HALO-compatible JSONL file and registers halo_* analysis tools.

Usage:

    pi -e packages/coding-agent/examples/extensions/halo

Defaults:

- Trace path: PI_HALO_TRACES_PATH, HALO_TRACES_PATH, or ~/.pi/agent/halo/traces.jsonl
- Project id: PI_HALO_PROJECT_ID or pi
- Service name: PI_HALO_SERVICE_NAME or pi-coding-agent

Commands:

- /halo-status shows the trace path.
- /halo-analyze asks pi to inspect actual traces with halo_* tools and propose harness improvements.
- /halo-engine <prompt> runs the external halo-engine CLI if it is installed on PATH.

Tools:

- halo_get_dataset_overview
- halo_query_traces
- halo_count_traces
- halo_view_trace
- halo_view_spans
- halo_search_trace
