type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug';

interface ErrorEventStream {
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown;
}

interface SafeConsoleOptions {
  stdout?: ErrorEventStream | null;
  stderr?: ErrorEventStream | null;
  consoleObject?: Pick<Console, ConsoleMethod>;
}

const guardedConsoles = new WeakSet<object>();
const guardedStreams = new WeakSet<object>();

export function isBrokenPipeError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (
    (error as NodeJS.ErrnoException).code === 'EPIPE'
    || (error as Error).message?.includes('broken pipe') === true
  );
}

/**
 * Packaged Windows GUI processes can inherit a temporary stdout/stderr pipe
 * from an installer, launcher or automation host.  Once that parent exits,
 * console.* may synchronously throw EPIPE or the stream may emit an unhandled
 * error.  Logging must never terminate the business application.
 */
export function installSafeConsole(options: SafeConsoleOptions = {}): void {
  const stdout = options.stdout === undefined ? process.stdout : options.stdout;
  const stderr = options.stderr === undefined ? process.stderr : options.stderr;
  const consoleObject = options.consoleObject ?? console;

  for (const stream of [stdout, stderr]) {
    if (!stream || guardedStreams.has(stream as object)) continue;
    guardedStreams.add(stream as object);
    (stream as ErrorEventStream).on('error', (_error: NodeJS.ErrnoException) => {
      // A GUI application has no reliable destination for stream failures.
      // Swallowing them is intentional; operational errors remain in the
      // renderer and crashReporter instead of crashing while logging.
    });
  }

  if (guardedConsoles.has(consoleObject as object)) return;
  guardedConsoles.add(consoleObject as object);

  const methods: ConsoleMethod[] = ['log', 'info', 'warn', 'error', 'debug'];
  for (const method of methods) {
    const original = consoleObject[method].bind(consoleObject);
    (consoleObject as Console)[method] = (...args: unknown[]) => {
      try {
        original(...args);
      } catch (error) {
        if (!isBrokenPipeError(error)) throw error;
      }
    };
  }
}
