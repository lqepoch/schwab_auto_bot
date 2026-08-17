import assert from 'node:assert/strict';
import test from 'node:test';
import { TraderApiClient } from '../dist/clients/trader.js';
import { MarketDataApiClient } from '../dist/clients/marketData.js';
import { SchwabGateway } from '../dist/gateway/schwabGateway.js';
import {
  MANIFEST_SERVICE_COUNT,
  READ_ONLY_GATEWAY_METHODS,
  REST_CONTRACT_MANIFEST,
  STREAMER_CONTRACT_MANIFEST,
  expectedFieldIds,
  manifestServiceNames,
} from '../dist/contracts/contractManifest.js';
import { STREAMER_SERVICE_CONTRACTS } from '../dist/types/streamerContracts.js';
import * as traderSchemas from '../dist/validation/traderSchemas.js';
import * as marketSchemas from '../dist/validation/marketDataSchemas.js';
import { MarketDataStreamClient } from '../dist/streamer/marketDataClient.js';

const clientClasses = { TraderApiClient, MarketDataApiClient };
const schemaModules = { ...traderSchemas, ...marketSchemas };

test('local REST manifest keeps client methods and runtime response schemas aligned', () => {
  for (const entry of REST_CONTRACT_MANIFEST) {
    const client = clientClasses[entry.client];
    assert.equal(typeof client.prototype[entry.method], 'function', `${entry.client}.${entry.method}`);
    if (entry.responseMethod) {
      assert.equal(typeof client.prototype[entry.responseMethod], 'function', `${entry.client}.${entry.responseMethod}`);
    }
    if (entry.runtimeSchema === null) {
      assert.notEqual(entry.httpMethod, 'GET');
      assert.equal(entry.responseMethod, undefined);
      continue;
    }
    const schema = schemaModules[entry.runtimeSchema];
    assert.equal(typeof schema?.parse, 'function', `${entry.runtimeSchema} for ${entry.method}`);
  }
});

test('local gateway manifest is an explicit read-only surface', () => {
  for (const method of READ_ONLY_GATEWAY_METHODS) {
    assert.equal(typeof SchwabGateway.prototype[method], 'function', method);
  }
  for (const method of ['placeOrder', 'previewOrder', 'replaceOrder', 'cancelOrder']) {
    assert.equal(SchwabGateway.prototype[method], undefined, method);
  }
});

test('local Streamer manifest covers every service, field range, and typed facade wrapper', () => {
  assert.equal(MANIFEST_SERVICE_COUNT, STREAMER_CONTRACT_MANIFEST.length);
  assert.deepEqual([...manifestServiceNames()], Object.keys(STREAMER_SERVICE_CONTRACTS));

  const wrappers = {
    LEVELONE_EQUITIES: ['subscribeLevelOneEquities', 'addLevelOneEquities', 'viewLevelOneEquities', 'unsubscribeLevelOneEquities'],
    LEVELONE_OPTIONS: ['subscribeLevelOneOptions', 'addLevelOneOptions', 'viewLevelOneOptions', 'unsubscribeLevelOneOptions'],
    LEVELONE_FUTURES: ['subscribeLevelOneFutures', 'addLevelOneFutures', 'viewLevelOneFutures', 'unsubscribeLevelOneFutures'],
    LEVELONE_FUTURES_OPTIONS: ['subscribeLevelOneFuturesOptions', 'addLevelOneFuturesOptions', 'viewLevelOneFuturesOptions', 'unsubscribeLevelOneFuturesOptions'],
    LEVELONE_FOREX: ['subscribeLevelOneForex', 'addLevelOneForex', 'viewLevelOneForex', 'unsubscribeLevelOneForex'],
    NYSE_BOOK: ['subscribeNyseBook', 'addNyseBook', 'viewNyseBook', 'unsubscribeNyseBook'],
    NASDAQ_BOOK: ['subscribeNasdaqBook', 'addNasdaqBook', 'viewNasdaqBook', 'unsubscribeNasdaqBook'],
    OPTIONS_BOOK: ['subscribeOptionsBook', 'addOptionsBook', 'viewOptionsBook', 'unsubscribeOptionsBook'],
    CHART_EQUITY: ['subscribeChartEquity', 'addChartEquity', 'viewChartEquity', 'unsubscribeChartEquity'],
    CHART_FUTURES: ['subscribeChartFutures', 'addChartFutures', 'viewChartFutures', 'unsubscribeChartFutures'],
    SCREENER_EQUITY: ['subscribeScreenerEquity', 'addScreenerEquity', 'viewScreenerEquity', 'unsubscribeScreenerEquity'],
    SCREENER_OPTION: ['subscribeScreenerOption', 'addScreenerOption', 'viewScreenerOption', 'unsubscribeScreenerOption'],
    ACCT_ACTIVITY: ['subscribeAccountActivity', 'unsubscribeAccountActivity'],
  };

  for (const entry of STREAMER_CONTRACT_MANIFEST) {
    const contract = STREAMER_SERVICE_CONTRACTS[entry.service];
    assert.ok(contract, entry.service);
    assert.equal(contract.delivery, entry.delivery, entry.service);
    assert.equal(contract.ordering, entry.ordering, entry.service);
    assert.deepEqual(Object.keys(contract.fields), expectedFieldIds(entry.fieldRange), entry.service);
    for (const method of wrappers[entry.service]) {
      assert.equal(typeof MarketDataStreamClient.prototype[method], 'function', `${entry.service}.${method}`);
    }
  }
  assert.equal(MarketDataStreamClient.prototype.viewAccountActivity, undefined);
});
