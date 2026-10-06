# Structural refactoring plan

The user authorized proceeding with the structural refactor on 2026-09-29.
The existing blueprint archives remain historical snapshots. No wipe or migration
is part of this change.

## Findings and constraints

- `main.py` imports `brokers/`. All eight Python files under `broker/` are
  byte-identical copies, but the two Zebu credential files differ. A folder rename
  without preserving resource paths would change authentication behavior.
- `main.py` owns application state, route registration, plugin construction,
  callback wiring, and startup handlers. Preserve the order of those operations.
- Broker modules and the execution engine receive mutable state by assignment.
  Compatibility imports must return the actual module, not copied attributes.
- Upstox has deferred imports of `main.app_state`. Keep these deferred to avoid
  an eager `main -> broker -> main` import cycle.
- The execution worker is sequential, stateful trading logic. Its statements,
  thresholds, sleeps, cancellation, modification, and error handling stay intact.
  No `np.select()` conversion is justified.
- Frontend files share browser state, DOM identifiers, worker messages, timers,
  and script ordering. Preserve these files byte-for-byte.
- Existing quirks are outside scope: root-level downloader imports, missing
  `math` binding in the direct market-order path, duplicate startup function
  names (both handlers are registered), duplicate Flattrade callback paths,
  launcher/documented port discrepancies, and incomplete requirements.

## Plan, in order

1. Capture original source bytes and hashes before editing application files.
2. Establish an isolated baseline: syntax, route order, OpenAPI schemas,
   representative API responses, callback behavior, startup registration, and
   execution-engine paper behavior. Block external calls and thread launches in
   the test process; never log in or submit live orders during verification.
3. Make `broker/` the implementation package. Retain `brokers/` as module aliases
   so legacy imports and mutable state assignments share the same objects.
4. Preserve the existing `brokers/` credential/cache paths explicitly. Do not
   relocate credential files, caches, instruments, logs, or configuration.
5. Move generic execution code into `services/`, request/response definitions
   into `models/`, and the unchanged dataframe filter into `utilities/`.
6. Move OAuth callback implementations into `broker/callbacks.py`; keep their
   registration order and public names in `main.py`, and inject the same state,
   logger, and plugin objects at the original registration point.
7. Add section comments to make the remaining application assembly readable.
8. Compare the result against the captured baseline and document outcomes and
   limitations. Leave packages and configuration versions unchanged.

## Every existing file planned for modification

| File | Change | Why the change is safe / validation |
| --- | --- | --- |
| `main.py` | Update internal imports; re-export moved models/filter/callbacks; section comments | Compare route order, schema, responses, startup order, and unchanged function ASTs |
| `broker/__init__.py` | Document canonical package | Comments only |
| `broker/base_broker.py` | Document interface ownership | Existing class stays intact |
| `broker/broker_manager.py` | Canonical base-class import | Preserve singleton and registration order |
| `broker/canonical_symbol_mapper.py` | Correct module documentation | Mapping logic unchanged |
| `broker/execution_engine.py` | Alias generic service module | Verify same module and injected state through all import paths |
| `broker/flattrade_broker.py` | Canonical interface import, section comments | All function bodies otherwise unchanged; root-relative resources stay at same depth |
| `broker/upstox_broker.py` | Canonical interface import; explicit legacy resource directory | Verify credential/cache paths equal baseline; preserve fallback order |
| `broker/zebu_broker.py` | Canonical interface import; explicit legacy resource directory | Verify credential/cache paths equal baseline; preserve fallback order |
| `brokers/__init__.py` | Document compatibility package | No eager registration or initialization |
| `brokers/base_broker.py` | Alias canonical module | Same class object via both import names |
| `brokers/broker_manager.py` | Alias canonical module | Same registry singleton via both import names |
| `brokers/canonical_symbol_mapper.py` | Alias canonical module | Same mapping singleton via both import names |
| `brokers/execution_engine.py` | Alias service module | Same injected globals via every import name |
| `brokers/flattrade_broker.py` | Alias canonical module | Same callback/state globals via both import names |
| `brokers/upstox_broker.py` | Alias canonical module | Same plugin class; original resource lookup locations |
| `brokers/zebu_broker.py` | Alias canonical module | Same plugin class; original resource lookup locations |
| `README.md` | Document layout and verification command | Documentation only |

## New files

- `broker/callbacks.py`: unchanged broker callback implementations and injection points.
- `broker/resource_paths.py`: location of existing broker resources.
- `services/__init__.py`, `services/execution_engine.py`: generic execution service.
- `models/__init__.py`, `models/api.py`: API models with unchanged fields/defaults.
- `utilities/__init__.py`, `utilities/filters.py`: unchanged dataframe filter.
- `tests/test_structural_refactor.py`, `tests/runtime_probe.py`: offline regression checks.
- `.refactor_baseline/sources.zip`, `.refactor_baseline/manifest.json`: original source
  recovery material and full original file hashes; keep local like existing source.
- `REFACTOR_PLAN.md`, `REFACTOR_REPORT.md`: reviewable plan and evidence.

## Dependency direction

`main -> models / utilities / broker / services / config / data`;
`broker adapters -> broker.base_broker`;
`services.execution_engine -> broker.broker_manager` (existing lazy imports);
`brokers.* -> canonical module` (one-way aliases).
Callbacks receive dependencies from main and do not import main.
Existing delayed Upstox imports of main remain delayed.

No agents, tool registries, or LLM prompts were found in the runtime source.
Existing markdown directives, browser text, credentials, and API payload strings
are retained. Available conversation context consists of the supplied request
and the user's clarification; historical design claims come from existing docs.
