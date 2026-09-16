'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { ControlRegistry } = loadTs('src/main/control.ts');
const { ClosingTimeController } = loadTs('src/main/closingTime.ts');

function fixture() {
  const control = new ControlRegistry();
  const sent = [];
  const hive = {
    registry: () => ({
      godId: 'god-1',
      agents: {
        'god-1': { name: 'Michael', isGod: true },
        'worker-delivered': { name: 'Pam' },
        'worker-queued': { name: 'Jim' }
      }
    }),
    send: (message, from) => sent.push({ message, from })
  };
  const controller = new ClosingTimeController(
    hive,
    () => ['god-1', 'worker-delivered', 'worker-queued'],
    () => null,
    () => assert.fail('cancel must not conclude closing time'),
    control
  );
  return { control, controller, sent };
}

test('cancel supersedes a delivered steer and replaces an undelivered steer', () => {
  const { control, controller, sent } = fixture();
  assert.deepEqual(controller.start(), { ok: true });

  const delivered = control.takeSteer('worker-delivered');
  assert.match(delivered, /office is shutting down/);
  assert.equal(control.snapshot('worker-queued').pendingSteers, 1);

  controller.cancel();

  // The already-delivered instruction gets a same-channel successor. The
  // queued instruction is removed before that successor is enqueued.
  for (const id of ['god-1', 'worker-delivered', 'worker-queued']) {
    assert.equal(control.snapshot(id).pendingSteers, 1, `${id} has exactly the retraction`);
    const note = control.takeSteer(id);
    assert.match(note, /^CLOSING TIME RETRACTED by the human\./);
    assert.match(note, /supersedes the earlier shutdown steer/);
    assert.match(note, /Resume normal operation and accept new work/);
    assert.equal(control.takeSteer(id), undefined, `${id} has no stale shutdown steer`);
  }

  assert.equal(sent.at(-1).message.subject, 'CLOSING TIME CANCELLED');
});

test('cancel is a no-op when closing time is inactive', () => {
  const { control, controller, sent } = fixture();
  controller.cancel();
  assert.equal(sent.length, 0);
  assert.equal(control.snapshot('god-1').pendingSteers, 0);
});
