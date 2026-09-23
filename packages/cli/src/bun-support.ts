/**
 * The oldest Bun line a CI lane still runs, as `major.minor.0`. `guren doctor`
 * and `guren upgrade` warn below it; scripts/workflow-bun-version.test.ts holds
 * it to the oldest entry of ci.yml's `bun-version` matrix, so dropping that
 * lane moves this floor in the same PR.
 */
export const OLDEST_TESTED_BUN = '1.3.0'
