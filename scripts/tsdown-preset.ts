/**
 * The tsdown settings every package shares; each tsdown.config.ts spreads this.
 * `fixedExtension: false` because every exports map names dist/*.js and
 * dist/*.d.ts, which tsdown would otherwise emit as .mjs/.d.mts on node;
 * `target: 'es2022'` because with no target tsdown lowers no syntax at all (it
 * reads engines.node, which no package declares) while the root tsconfig
 * promises ES2022. Scripts run `bun --bun tsdown`; under Node it needs the
 * optional `unrun` peer. A package's `deps.neverBundle` is only for what cannot
 * be declared — a peer closing a build-order cycle, or `bun:sqlite`.
 */
export const tsdownPreset = {
  target: 'es2022',
  fixedExtension: false,
} as const
