import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AccountHashResolver,
  LEVELONE_EQUITIES_FIELDS as rootFields,
  serializeLevelOneEquityFields as rootSerialize,
  LEVELONE_OPTIONS_FIELDS as rootOptionFields,
  LEVELONE_EQUITIES_FIELDS as rootEquityFields,
  LEVELONE_EQUITIES_SERVICE_FIELDS as rootEquityServiceFields,
  STREAMER_SERVICE_CONTRACTS as rootContracts,
  StreamerSnapshotCache as RootSnapshotCache,
  SchwabGateway as RootGateway,
  TokenStore as RootTokenStore,
  REST_CONTRACT_MANIFEST as rootRestManifest,
} from 'schwab-owokit';
import {
  LEVELONE_EQUITIES_FIELDS as subpathFields,
  serializeLevelOneEquityFields as subpathSerialize,
} from 'schwab-owokit/streamer-fields';
import { AccountHashResolver as AccountHashResolverSubpath } from 'schwab-owokit/accounts';
import {
  LEVELONE_OPTIONS_FIELDS as subpathOptionFields,
  LEVELONE_EQUITIES_SERVICE_FIELDS as subpathEquityServiceFields,
  STREAMER_SERVICE_CONTRACTS as subpathContracts,
} from 'schwab-owokit/streamer-contracts';
import { StreamerSnapshotCache as SubpathSnapshotCache } from 'schwab-owokit/streamer-snapshot';
import { SchwabGateway as SubpathGateway } from 'schwab-owokit/gateway';
import { TokenStore as SubpathTokenStore } from 'schwab-owokit/token-store';
import { REST_CONTRACT_MANIFEST as subpathRestManifest } from 'schwab-owokit/contract-manifest';
import {
  BrokerWriteCoordinator as AutomationBrokerWriteCoordinator,
  ExecutionJournal as AutomationExecutionJournal,
  PriceExplorer as AutomationPriceExplorer,
  SchwabRestClient as AutomationSchwabRestClient,
  UnknownWriteReconciliation as AutomationUnknownWriteReconciliation,
  parseRuntimePolicy as automationParseRuntimePolicy,
  runSchwabAutomationCli,
} from 'schwab-owokit/automation';

test('package root and streamer-fields subpath share the canonical Level One contract', () => {
  assert.equal(rootFields, subpathFields);
  assert.equal(rootSerialize, subpathSerialize);
  assert.equal(rootFields['1'].name, 'Bid Price');
  assert.equal(rootFields['2'].name, 'Ask Price');
  assert.equal(rootFields['3'].name, 'Last Price');
});

test('account resolver is available from root and dedicated subpath', () => {
  assert.equal(AccountHashResolver, AccountHashResolverSubpath);
});

test('new streamer, gateway, and token-store contracts stay identical across root and subpaths', () => {
  assert.equal(rootOptionFields, subpathOptionFields);
  assert.equal(rootEquityServiceFields, subpathEquityServiceFields);
  assert.equal(rootContracts, subpathContracts);
  assert.equal(RootSnapshotCache, SubpathSnapshotCache);
  assert.equal(RootGateway, SubpathGateway);
  assert.equal(RootTokenStore, SubpathTokenStore);
  assert.equal(rootRestManifest, subpathRestManifest);
  assert.deepEqual(Object.keys(rootContracts), [
    'LEVELONE_EQUITIES',
    'LEVELONE_OPTIONS',
    'LEVELONE_FUTURES',
    'LEVELONE_FUTURES_OPTIONS',
    'LEVELONE_FOREX',
    'NYSE_BOOK',
    'NASDAQ_BOOK',
    'OPTIONS_BOOK',
    'CHART_EQUITY',
    'CHART_FUTURES',
    'SCREENER_EQUITY',
    'SCREENER_OPTION',
    'ACCT_ACTIVITY',
  ]);
  assert.deepEqual(
    Object.keys(rootEquityServiceFields),
    Object.keys(rootEquityFields),
  );
  assert.equal(rootEquityServiceFields['51'].type, 'boolean');
  assert.equal(rootEquityServiceFields['3'].type, 'number');
  assert.equal(rootContracts.ACCT_ACTIVITY.delivery, 'all-sequence');
});

test('automation subpath exposes the stable guarded execution boundary without import side effects', () => {
  assert.equal(typeof runSchwabAutomationCli, 'function');
  assert.equal(typeof AutomationSchwabRestClient, 'function');
  assert.equal(typeof AutomationBrokerWriteCoordinator, 'function');
  assert.equal(typeof AutomationExecutionJournal, 'function');
  assert.equal(typeof AutomationPriceExplorer, 'function');
  assert.equal(typeof AutomationUnknownWriteReconciliation, 'function');
  assert.equal(typeof automationParseRuntimePolicy, 'function');
});
