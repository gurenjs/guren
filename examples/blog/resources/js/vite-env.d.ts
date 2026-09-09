// `@vite/client` is a virtual module the Vite dev server serves for HMR;
// nothing ships a declaration for it, and TypeScript 6+ checks that
// side-effect imports resolve (TS2882).
declare module '@vite/client'

interface ImportMetaEnv {
  /** `true` under `vite --mode prototype`, `false` in every other build (RFC 0021). */
  readonly GUREN_PROTOTYPE: boolean
}
