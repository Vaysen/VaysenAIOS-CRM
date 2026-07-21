/**
 * Baileys 7 is ESM-only while this NestJS application is compiled as CommonJS.
 * TypeScript rewrites a regular `import()` to `require()` under that target, so
 * keep the native Node.js loader behind a generated function and load it lazily.
 */
type BaileysModule = typeof import('@whiskeysockets/baileys');

type NativeImporter = (specifier: string) => Promise<BaileysModule>;

const nativeImport = new Function(
  'specifier',
  'return import(specifier)',
) as NativeImporter;

let baileysModulePromise: Promise<BaileysModule> | undefined;

export async function loadBaileys(): Promise<BaileysModule> {
  baileysModulePromise ??= nativeImport('@whiskeysockets/baileys').then((module) => {
    if (
      typeof module.makeWASocket !== 'function'
      || typeof module.useMultiFileAuthState !== 'function'
      || typeof module.downloadMediaMessage !== 'function'
      || !module.DisconnectReason
    ) {
      throw new Error('Baileys ESM module is missing required runtime exports');
    }
    return module;
  });

  try {
    return await baileysModulePromise;
  } catch (error) {
    baileysModulePromise = undefined;
    throw error;
  }
}
