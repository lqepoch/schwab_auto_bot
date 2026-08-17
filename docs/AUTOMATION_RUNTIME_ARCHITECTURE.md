# Automation runtime architecture

## Production boundary

`src/main.ts` is the stable process entry. It delegates to `src/automation/runtimeOrchestrator.ts`, which is the composition/lifecycle boundary for the Schwab automation process. Process-management tooling continues to launch `src/main.ts`; state reports preserve that entry path.

The orchestrator wires established production modules and does not own generic OAuth transport, generic WebSocket protocol handling, broker HTTP retry policy, unknown-write matching rules, or pure opening-order indexing.

## Module ownership

| Module | Owns | Inputs | Outputs / effects | Critical invariant |
| --- | --- | --- | --- | --- |
| `auth.ts` + `auth/tokenManager.ts` | automation auth policy + SDK OAuth transport | v1 auth file, callback URL, environment credentials | access token, atomic credential persistence | weekly reauthorization metadata and existing auth-file schema remain compatible |
| `activity_stream.ts` + `streamer/streamerClient.ts` | account-activity interpretation + generic Streamer lifecycle | Streamer context, ACCT_ACTIVITY frames | debounced activity hints | Streamer hints never become authoritative broker state; REST reconciliation remains authoritative |
| `automation/orderIndex.ts` | deterministic opening-order classification/indexing | authoritative order snapshot, runtime policy, trading date | active-order ordering and strategy→primary-order map | same price/time/order-id ordering and policy filters for identical snapshots |
| `broker_write_coordinator.ts` | final mutation serialization and write-intent lifecycle | validated broker intent | POST/PUT/DELETE transport calls | no final broker mutation can bypass the final write gate or persisted intent |
| `unknown_write_reconciliation.ts` | WAL/unknown-outcome recovery | persisted intent, authoritative orders | resolved/pending write state | ambiguous outcomes stay fail-closed and are never blindly retried |
| `order_snapshot_coordinator.ts` | authoritative REST snapshot coordination | Schwab REST orders/positions | reconciled full/fill snapshots | final writes require a fresh, reconciled full snapshot |
| `fixed_price_cycle.ts` / `refresh_*` | fixed-price eligibility, pacing, per-round rules | strategy/order state | refresh/replenishment decisions | same strategy is bounded per refresh round; quota headroom is preserved |
| `exit_policy.ts` | exit eligibility and refresh timing | inventory/order state | exit timing decisions | exit generation cannot bypass quantity, timing, and sell-disable gates |
| `price_explorer.ts` | bounded net-price exploration state | opening order/fill observations | explorer actions/snapshot | bounded prices and active-order limits remain enforced |
| `runtimeOrchestrator.ts` | dependency wiring, lifecycle, scheduling, state-machine sequencing | CLI/runtime policy and module ports | scheduling, audit events, controlled shutdown | orchestration cannot bypass Preview, WAL, snapshot freshness, broker-write serialization, or zero-retry unknown-outcome handling |

## Failure model

The runtime uses fail-closed behavior for broker-write uncertainty. Persisting a write intent precedes final broker mutation. Network/timeout/5xx or an unprovable mutation result leaves a pending unknown-write record that blocks later final writes until authoritative REST reconciliation proves the outcome. Audit-journal write failures are surfaced through the runtime failure callback. OAuth invalid-grant requires interactive reauthorization. Streamer loss degrades event-driven wakeups; REST snapshots continue to define broker state.

## Rollback boundary

Architecture changes are source-compatible with the existing process entry and auth-state file. Reverting the convergence PR restores the prior orchestration implementation without a state-schema migration. No benchmark artifact or CI performance baseline participates in live trading state.

## Verification contract

Production refactors must pass:

- SDK + automation + examples + benchmark TypeScript checks;
- Node 24 native TypeScript `erasableSyntaxOnly` audit for the automation runtime;
- unit/contract/characterization tests;
- dead-file/dependency hygiene checks;
- package-export validation;
- deterministic runtime benchmark regression gates;
- `git diff --check` and repository invariants.

Live Schwab Place/Replace/Cancel calls are excluded from CI and architecture refactoring validation.
