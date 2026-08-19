import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

function methodBody(source, method, nextMethod) {
  const start = source.indexOf(`  async ${method}(`);
  assert.notEqual(start, -1, `${method} must exist`);
  const end = source.indexOf(`  async ${nextMethod}(`, start + 1);
  assert.notEqual(end, -1, `${nextMethod} must follow ${method}`);
  return source.slice(start, end);
}

test('body-only Trader reads delegate to the metadata-preserving canonical transport path', async () => {
  const source = await readFile(new URL('../src/clients/trader.ts', import.meta.url), 'utf8');
  const pairs = [
    ['getAccountNumbers', 'getAccountNumbersWithResponse'],
    ['getOrdersAcrossAccounts', 'getOrdersAcrossAccountsWithResponse'],
    ['getTransactions', 'getTransactionsWithResponse'],
    ['getTransaction', 'getTransactionWithResponse'],
    ['getUserPreferences', 'getUserPreferencesWithResponse'],
  ];

  for (const [method, withResponse] of pairs) {
    const body = methodBody(source, method, withResponse);
    assert.match(body, new RegExp(`this\\.${withResponse}\\(`), `${method} must delegate to ${withResponse}`);
    assert.doesNotMatch(body, /this\.request(?:WithResponse)?</, `${method} must not own a second transport path`);
  }
});

test('single-transaction body normalization remains outside the canonical transport implementation', async () => {
  const source = await readFile(new URL('../src/clients/trader.ts', import.meta.url), 'utf8');
  const body = methodBody(source, 'getTransaction', 'getTransactionWithResponse');
  assert.match(body, /const data = \(await this\.getTransactionWithResponse\(accountNumber, transactionId\)\)\.body;/);
  assert.match(body, /Array\.isArray\(data\)/);
  assert.match(body, /Transaction not found in response array/);
});
