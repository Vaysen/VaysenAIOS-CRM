import assert from 'node:assert/strict';
import test from 'node:test';

import { assertNoPublishedHostPorts } from './assert-no-published-host-ports.mjs';

test('accepts Docker null and empty port maps', () => {
  assert.doesNotThrow(() => assertNoPublishedHostPorts(null));
  assert.doesNotThrow(() => assertNoPublishedHostPorts({}));
});

test('accepts an exposed container port with no host publication', () => {
  assert.doesNotThrow(() => assertNoPublishedHostPorts({ '18789/tcp': null }));
  assert.doesNotThrow(() => assertNoPublishedHostPorts({ '18789/tcp': [] }));
});

test('rejects every actual host binding, including loopback and routed IPv6', () => {
  for (const binding of [
    { HostIp: '0.0.0.0', HostPort: '18789' },
    { HostIp: '127.0.0.1', HostPort: '18789' },
    { HostIp: '::', HostPort: '' },
  ]) {
    assert.throws(
      () => assertNoPublishedHostPorts({ '18789/tcp': [binding] }),
      /HOST_PORT_PUBLISHED/,
    );
  }
});

test('fails closed for malformed Docker inspect payloads', () => {
  assert.throws(() => assertNoPublishedHostPorts([]), /PORTS_PAYLOAD_INVALID/);
  assert.throws(
    () => assertNoPublishedHostPorts({ '18789/tcp': 'unexpected' }),
    /PORT_BINDINGS_INVALID/,
  );
  assert.throws(
    () => assertNoPublishedHostPorts({ unexpected: null }),
    /CONTAINER_PORT_INVALID/,
  );
});
