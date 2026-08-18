import {
  assertRealPgEnabled,
  assertRealPgIdentity,
  assertRealPgSwitchEnabled,
  parseRealPgDatabaseUrl,
} from './real-pg-safety';

describe('communications real PostgreSQL safety guard', () => {
  it('requires an explicit enable switch', () => {
    expect(() => assertRealPgEnabled({})).toThrow('LAN_COMMUNICATIONS_REAL_PG=1');
    expect(() => assertRealPgEnabled({ LAN_COMMUNICATIONS_REAL_PG: '0' })).toThrow('LAN_COMMUNICATIONS_REAL_PG=1');
    expect(() => assertRealPgEnabled({ LAN_COMMUNICATIONS_REAL_PG: '1' })).not.toThrow();
    expect(() => assertRealPgSwitchEnabled('LAN_OPPORTUNITIES_REAL_PG', {})).toThrow('LAN_OPPORTUNITIES_REAL_PG=1');
    expect(() => assertRealPgSwitchEnabled('LAN_OPPORTUNITIES_REAL_PG', { LAN_OPPORTUNITIES_REAL_PG: '1' })).not.toThrow();
  });

  it.each([
    'postgresql://lan_tools:secret@10.0.0.2:55433/lan_test_db',
    'postgresql://lan_tools:secret@db.internal:55433/lan_test_db',
    'postgresql://lan_tools:secret@::1:55433/lan_test_db',
  ])('rejects a non-loopback or malformed host: %s', (url) => {
    expect(() => parseRealPgDatabaseUrl(url)).toThrow();
  });

  it.each([
    'postgresql://lan_tools:secret@127.0.0.1:55433/postgres',
    'postgresql://lan_tools:secret@127.0.0.1:55433/production',
    'postgresql://lan_tools:secret@127.0.0.1:55433/vaysen-crm',
    'postgresql://lan_tools:secret@127.0.0.1:55433/lan_second_wave',
  ])('rejects a production-style or non-disposable database name: %s', (url) => {
    expect(() => parseRealPgDatabaseUrl(url)).toThrow();
  });

  it.each([
    undefined,
    '',
    'not-a-url',
    'mysql://lan_tools:secret@127.0.0.1:55433/lan_test_db',
    'postgresql://lan_tools:secret@127.0.0.1:5432/lan_test_db',
    'postgresql://lan_tools:secret@127.0.0.1:55433/lan%ZZtest_db',
    'postgresql://lan_tools:sec\nret@127.0.0.1:55433/lan_test_db',
  ])('rejects malformed credentials or URL: %s', (url) => {
    expect(() => parseRealPgDatabaseUrl(url)).toThrow();
  });

  it('accepts the designated loopback disposable URL', () => {
    expect(parseRealPgDatabaseUrl('postgresql://lan_tools:secret@127.0.0.1:55433/lan_second_wave_stage1_fix_20260803')).toEqual({
      database: 'lan_second_wave_stage1_fix_20260803',
      user: 'lan_tools',
      serverHost: '127.0.0.1',
      serverPort: '55433',
    });
  });

  it('accepts the designated IPv6 loopback disposable URL', () => {
    expect(parseRealPgDatabaseUrl('postgresql://lan_tools:secret@[::1]:55433/lan_test_db')).toEqual({
      database: 'lan_test_db',
      user: 'lan_tools',
      serverHost: '::1',
      serverPort: '55433',
    });
  });

  it('rejects a connected identity mismatch before destructive work can proceed', () => {
    const expected = parseRealPgDatabaseUrl('postgresql://lan_tools:secret@127.0.0.1:55433/lan_second_wave_stage1_fix_20260803');
    expect(() => assertRealPgIdentity(expected, {
      currentDatabase: expected.database,
      currentUser: expected.user,
      serverAddr: '10.0.0.5',
      serverPort: expected.serverPort,
    })).toThrow('identity');
    expect(() => assertRealPgIdentity(expected, {
      currentDatabase: 'another_test_db',
      currentUser: expected.user,
      serverAddr: '127.0.0.1',
      serverPort: expected.serverPort,
    })).toThrow('identity');
  });

  it.each([
    ['127.0.0.1', '127.0.0.1/32'],
    ['::1', '::1/128'],
  ])('accepts PostgreSQL host-address text with its full host prefix: %s', (urlHost, serverAddr) => {
    const url = urlHost === '::1'
      ? 'postgresql://lan_tools:secret@[::1]:55433/lan_test_db'
      : 'postgresql://lan_tools:secret@127.0.0.1:55433/lan_test_db';
    const expected = parseRealPgDatabaseUrl(url);

    expect(() => assertRealPgIdentity(expected, {
      currentDatabase: expected.database,
      currentUser: expected.user,
      serverAddr,
      serverPort: expected.serverPort,
    })).not.toThrow();
  });

  it.each(['127.0.0.1/24', '::1/64', '10.0.0.5/32'])('rejects a non-host or non-loopback server address: %s', (serverAddr) => {
    const expected = parseRealPgDatabaseUrl('postgresql://lan_tools:secret@127.0.0.1:55433/lan_test_db');

    expect(() => assertRealPgIdentity(expected, {
      currentDatabase: expected.database,
      currentUser: expected.user,
      serverAddr,
      serverPort: expected.serverPort,
    })).toThrow('identity');
  });
});
