import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySubscriptionMutation,
  parametersForState,
} from '../src/streamer/subscriptionState.ts';

test('canonical subscription state replaces, merges, views, and unsubscribes by service', () => {
  const states = new Map();
  const generations = new Map<string, number>();

  applySubscriptionMutation(states, generations, 'SUBS', 'LEVELONE_OPTIONS', {
    keys: 'QQQ_1,QQQ_2',
    fields: '0,1',
  });
  assert.deepEqual(parametersForState(states.get('LEVELONE_OPTIONS')), {
    fields: '0,1',
    keys: 'QQQ_1,QQQ_2',
  });

  applySubscriptionMutation(states, generations, 'ADD', 'LEVELONE_OPTIONS', {
    keys: ['QQQ_3'],
  });
  assert.deepEqual(parametersForState(states.get('LEVELONE_OPTIONS')), {
    fields: '0,1',
    keys: 'QQQ_1,QQQ_2,QQQ_3',
  });

  applySubscriptionMutation(states, generations, 'VIEW', 'LEVELONE_OPTIONS', {
    fields: '0,1,2',
  });
  assert.deepEqual(parametersForState(states.get('LEVELONE_OPTIONS')), {
    fields: '0,1,2',
    keys: 'QQQ_1,QQQ_2,QQQ_3',
  });

  applySubscriptionMutation(states, generations, 'UNSUBS', 'LEVELONE_OPTIONS', { keys: 'QQQ_2' });
  assert.deepEqual(parametersForState(states.get('LEVELONE_OPTIONS')), {
    fields: '0,1,2',
    keys: 'QQQ_1,QQQ_3',
  });

  applySubscriptionMutation(states, generations, 'UNSUBS', 'LEVELONE_OPTIONS');
  assert.equal(states.has('LEVELONE_OPTIONS'), false);
});
