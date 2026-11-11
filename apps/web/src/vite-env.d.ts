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
  };
  export default seed;
}
