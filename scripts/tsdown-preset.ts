/**
 * The tsdown settings every package shares, and why. Each package's
 * tsdown.config.ts spreads this and adds its entries and deltas.
 *
 * tsdown's defaults already cover format (esm), outDir (dist), clean,
 * platform (node) and dts (on when package.json declares `types`). Two
 * settings are not defaults:
 *
 * - `fixedExtension: false` — every exports map names dist/*.js and
 *   dist/*.d.ts; on the node platform tsdown would emit .mjs/.d.mts.
 * - `target: 'es2022'` — without a target tsdown lowers no syntax at all (it
 *   reads engines.node, which no package declares), whereas the root tsconfig
 *   promises ES2022 output.
 *
 * Package scripts run `bun --bun tsdown`: under Node, tsdown needs the
 * optional `unrun` peer to load a TypeScript config file; under Bun it loads
 * natively.
 *
 * `deps.neverBundle` is per package and lists only what the package imports
 * without declaring: declared dependencies and peers are external by default,
 * while an undeclared sibling would be resolved to its source through the
 * root tsconfig paths and bundled in.
 */
export const tsdownPreset = {
  target: 'es2022',
  fixedExtension: false,
} as const
