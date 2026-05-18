/**
 * Ambient declarations for `wink-bm25-text-search@^3`.
 *
 * The published package ships JS only — no .d.ts and no @types/ entry on npm.
 * Surface verified against v3.1.2 source at
 * https://registry.npmjs.org/wink-bm25-text-search/3.1.2 (module.exports = a
 * bm25fIMS constructor function returning an engine with the 8 methods
 * documented in the package README — we declare the 5 we use).
 */
declare module 'wink-bm25-text-search' {
  export interface WinkBM25Index {
    defineConfig: (cfg: {
      fldWeights: Record<string, number>;
      ovFldNames?: string[];
      bm25Params?: { k1?: number; b?: number; k?: number };
    }) => void;
    definePrepTasks: (tasks: Array<(text: string) => string[]>) => void;
    addDoc: (doc: Record<string, string>, id: string) => void;
    consolidate: () => void;
    search: (query: string, limit?: number) => Array<[string, number]>;
  }
  const bm25fIMS: () => WinkBM25Index;
  export default bm25fIMS;
}
