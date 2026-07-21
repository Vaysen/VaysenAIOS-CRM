import { EventEmitter } from 'events';
import { installSafeConsole, isBrokenPipeError } from '../src/main/safe-console';

describe('packaged main-process safe console', () => {
  it('recognizes Windows broken-pipe failures', () => {
    expect(isBrokenPipeError(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))).toBe(true);
    expect(isBrokenPipeError(new Error('ordinary failure'))).toBe(false);
  });

  it('swallows synchronous EPIPE from console methods', () => {
    const fake = {
      log: jest.fn((_message?: unknown) => { throw Object.assign(new Error('broken pipe'), { code: 'EPIPE' }); }),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
    installSafeConsole({ stdout: null, stderr: null, consoleObject: fake });
    expect(() => fake.log('layout')).not.toThrow();
  });

  it('handles an EPIPE error event instead of leaving it unhandled', () => {
    const stream = new EventEmitter();
    const fake = {
      log: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    };
    installSafeConsole({ stdout: stream, stderr: null, consoleObject: fake });
    expect(() => stream.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))).not.toThrow();
  });
});
