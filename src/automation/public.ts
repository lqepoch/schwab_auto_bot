/** Stable module boundary for guarded automated Schwab order execution. */
export { runSchwabAutomationCli } from './runtime.ts';
export { SchwabRestClient } from './broker/schwabClient.ts';
export { SchwabTokenProvider, requireWeeklyReauthorization, status as authStatus } from './auth/provider.ts';
export { BrokerWriteCoordinator } from './broker/writeCoordinator.ts';
export { OrderSnapshotCoordinator, RuntimeStartupCoordinator } from './broker/orderSnapshotCoordinator.ts';
export { PriceExplorer, MAX_ACTIVE_ORDERS } from './execution/priceExplorer.ts';
export { parseRuntimePolicy } from './policy/runtime.ts';
export { orderWritePreflight, replacementSourceViolation, EXISTING_ORDER_REPLACE_NO_PREVIEW } from './execution/orderWritePreflight.ts';
export { orderPolicyViolation, orderInfo, EXIT_ORDER_PRICE } from './policy/order.ts';
export { UnknownWriteReconciliation, fingerprintOrder, safePath } from './state/unknownWriteReconciliation.ts';
export { ExecutionJournal } from './observability/executionJournal.ts';
