import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function assertNoPublishedHostPorts(ports) {
  if (ports === null) return;
  if (typeof ports !== 'object' || Array.isArray(ports)) {
    throw new Error('PORTS_PAYLOAD_INVALID');
  }

  for (const [containerPort, bindings] of Object.entries(ports)) {
    if (!/^\d+\/(?:tcp|udp|sctp)$/.test(containerPort)) {
      throw new Error('CONTAINER_PORT_INVALID');
    }
    // Docker reports an exposed-but-unpublished port as
    // { "18789/tcp": null }.  Only a non-empty binding array means the
    // container is reachable through a host-published port.
    if (bindings === null) continue;
    if (!Array.isArray(bindings)) {
      throw new Error('PORT_BINDINGS_INVALID');
    }
    if (bindings.length > 0) {
      throw new Error('HOST_PORT_PUBLISHED');
    }
  }
}

function runCli() {
  try {
    const input = readFileSync(0, 'utf8').trim();
    const ports = input === '' ? null : JSON.parse(input);
    assertNoPublishedHostPorts(ports);
  } catch (error) {
    const code = error instanceof Error ? error.message : 'UNKNOWN';
    process.stderr.write(`HOST_PORT_ASSERTION_FAILED:${code}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli();
}
