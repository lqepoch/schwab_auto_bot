import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AccountHashResolver,
  LEVELONE_EQUITIES_FIELDS as rootFields,
  serializeLevelOneEquityFields as rootSerialize,
} from 'schwab-owokit';
import {
  LEVELONE_EQUITIES_FIELDS as subpathFields,
  serializeLevelOneEquityFields as subpathSerialize,
} from 'schwab-owokit/streamer-fields';
import { AccountHashResolver as AccountHashResolverSubpath } from 'schwab-owokit/accounts';

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
