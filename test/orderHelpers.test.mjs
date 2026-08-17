import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatSchwabOptionSymbol,
  parseSchwabOptionSymbol,
} from '../dist/options/optionSymbol.js';
import {
  buildEquityOrder,
  buildOcoOrder,
  buildSingleOptionOrder,
  buildTriggerOrder,
  buildVerticalOptionOrder,
} from '../dist/orders/orderBuilders.js';

test('formatSchwabOptionSymbol produces Schwab 21-character option symbols', () => {
  const symbol = formatSchwabOptionSymbol({
    underlying: 'QQQ',
    expiration: '2026-08-14',
    contractType: 'PUT',
    strike: 740,
  });
  assert.equal(symbol, 'QQQ   260814P00740000');
  assert.deepEqual(parseSchwabOptionSymbol(symbol), {
    underlying: 'QQQ',
    expiration: '2026-08-14',
    contractType: 'PUT',
    strike: 740,
    raw: symbol,
  });
});

test('option symbol helpers reject invalid calendar dates and over-precision strikes', () => {
  assert.throws(() => formatSchwabOptionSymbol({
    underlying: 'QQQ', expiration: '2026-02-30', contractType: 'PUT', strike: 740,
  }), /Invalid calendar date/);
  assert.throws(() => formatSchwabOptionSymbol({
    underlying: 'QQQ', expiration: '2026-08-14', contractType: 'PUT', strike: 740.0005,
  }), /three decimal places/);
});

test('buildVerticalOptionOrder creates a validated Schwab NET_DEBIT vertical', () => {
  const buy = 'QQQ   260814P00740000';
  const sell = 'QQQ   260814P00739000';
  const order = buildVerticalOptionOrder({
    buySymbol: buy,
    sellSymbol: sell,
    quantity: 1,
    buyInstruction: 'BUY_TO_OPEN',
    sellInstruction: 'SELL_TO_OPEN',
    orderType: 'NET_DEBIT',
    price: 0.9,
  });

  assert.equal(order.orderType, 'NET_DEBIT');
  assert.equal(order.complexOrderStrategyType, 'VERTICAL');
  assert.equal(order.orderStrategyType, 'SINGLE');
  assert.equal(order.price, 0.9);
  assert.deepEqual(order.orderLegCollection?.map((leg) => [leg.instruction, leg.instrument?.symbol]), [
    ['BUY_TO_OPEN', buy],
    ['SELL_TO_OPEN', sell],
  ]);
});

test('buildVerticalOptionOrder rejects mismatched option contracts', () => {
  assert.throws(() => buildVerticalOptionOrder({
    buySymbol: 'QQQ   260814P00740000',
    sellSymbol: 'SPY   260814P00739000',
    quantity: 1,
    buyInstruction: 'BUY_TO_OPEN',
    sellInstruction: 'SELL_TO_OPEN',
    orderType: 'NET_DEBIT',
    price: 0.9,
  }), /same underlying/);
});

test('conditional helpers build Schwab TRIGGER and OCO structures without mutating children', () => {
  const entry = buildEquityOrder({
    symbol: 'AAPL', quantity: 1, instruction: 'BUY', orderType: 'LIMIT', price: 200,
  });
  const target = buildEquityOrder({
    symbol: 'AAPL', quantity: 1, instruction: 'SELL', orderType: 'LIMIT', price: 210,
  });
  const stop = buildSingleOptionOrder({
    symbol: 'QQQ   260814P00740000', quantity: 1, instruction: 'SELL_TO_CLOSE', orderType: 'LIMIT', price: 1,
  });
  const oco = buildOcoOrder(target, stop);
  const trigger = buildTriggerOrder(entry, oco);

  assert.equal(oco.orderStrategyType, 'OCO');
  assert.equal(oco.childOrderStrategies?.length, 2);
  assert.equal(trigger.orderStrategyType, 'TRIGGER');
  assert.equal(trigger.childOrderStrategies?.[0]?.orderStrategyType, 'OCO');
  assert.equal(entry.orderStrategyType, 'SINGLE');
});
