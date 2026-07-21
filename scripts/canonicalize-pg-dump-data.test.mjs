import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalizePgDumpData } from './canonicalize-pg-dump-data.mjs';

const prefix = '-- PostgreSQL database dump\nSET statement_timeout = 0;\n';
const suffix = "SELECT pg_catalog.setval('public.thing_id_seq', 9, true);\n-- PostgreSQL database dump complete\n";

test('sorts rows only inside each COPY block and preserves table boundaries', () => {
  const first = `${prefix}COPY public.thing (id, value) FROM stdin;\n2\tbeta\n1\talpha\\nline\n\\.\nCOPY public.other (id) FROM stdin;\nz\na\n\\.\n${suffix}`;
  const second = `${prefix}COPY public.thing (id, value) FROM stdin;\n1\talpha\\nline\n2\tbeta\n\\.\nCOPY public.other (id) FROM stdin;\na\nz\n\\.\n${suffix}`;
  assert.equal(canonicalizePgDumpData(first), canonicalizePgDumpData(second));
  assert.match(canonicalizePgDumpData(first), /1\talpha\\nline\n2\tbeta/);
});

test('does not globally sort metadata or sequence statements', () => {
  const input = `${prefix}${suffix}`;
  assert.equal(canonicalizePgDumpData(input), input);
});

test('fails closed for malformed COPY framing and non-LF input', () => {
  assert.throws(
    () => canonicalizePgDumpData('COPY public.thing (id) FROM stdin;\n1\n'),
    /unterminated COPY block/,
  );
  assert.throws(() => canonicalizePgDumpData('\\.\n'), /unexpected COPY terminator/);
  assert.throws(() => canonicalizePgDumpData('line\r\n'), /LF line endings/);
});
