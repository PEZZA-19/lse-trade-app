/// <reference types="vite/client" />
interface ImportMetaEnv {
  /** "1" builds the static preview that runs on in-browser demo data. */
  readonly VITE_DEMO?: string;
  /** "1" uses #/routes (the local single-file demo opened from a folder). */
  readonly VITE_HASH_ROUTER?: string;
}

declare module 'virtual:lse-demo-seed' {
  import type { BillCreate, ReadStatement } from '@lse/shared';
  const seed: {
    bills: BillCreate[];
    statement: { statement: ReadStatement; fileName: string } | null;
    /**
     * Private local demo only: the business's own records, replayed through the demo API in order.
     * `{name}` in a path and a body string "$ref:name" are replaced with the id saved by an earlier
     * call's `save`. With `replaceExamples`, the invented example jobs are left out.
     */
    calls?: { method: string; path: string; body?: unknown; save?: string }[];
    replaceExamples?: boolean;
  };
  export default seed;
}
