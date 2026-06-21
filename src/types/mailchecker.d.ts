/**
 * REFERRAL-FREE-KEY-SIGNUP-W1 — ambient types for the untyped `mailchecker` pkg
 * (no bundled .d.ts, no @types). Verified against the published v6.0.20 CJS
 * export shape: `module.exports = { isValid, blacklist, addCustomDomains }`.
 */
declare module 'mailchecker' {
  /** true = valid + NOT a disposable/throwaway domain; false = invalid or disposable. */
  export function isValid(email: string): boolean;
  /** Adds extra domains to the disposable blacklist at runtime. */
  export function addCustomDomains(domains: string[]): void;
  /** The bundled disposable-domain blacklist. */
  export const blacklist: string[];
}
