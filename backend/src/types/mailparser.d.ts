declare module 'mailparser' {
  export function simpleParser(source: Buffer): Promise<any>;
}
