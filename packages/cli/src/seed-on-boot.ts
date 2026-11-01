/**
 * The one spelling of boot-time seeding in `config/database.ts`, and the rewrite
 * `guren upgrade` applies to the denylist form older scaffolds shipped. Seeders
 * write demo accounts, so seeding is allowed by name: an unset NODE_ENV (a server
 * started without one) must not seed. `packages/create-app/templates/database/`
 * and the examples spell the same expression.
 */
export const SEED_ON_BOOT_EXPRESSION = "process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'"

export const SEED_ON_BOOT_OPTION = `{ seedOnBoot: ${SEED_ON_BOOT_EXPRESSION} }`

const LEGACY_SEED_ON_BOOT = /(\bseedOnBoot\s*:\s*)process\.env\.NODE_ENV\s*!==?\s*(['"])production\2/g

export function hasLegacySeedOnBoot(source: string): boolean {
  return new RegExp(LEGACY_SEED_ON_BOOT.source).test(source)
}

export function rewriteLegacySeedOnBoot(source: string): string {
  return source.replace(LEGACY_SEED_ON_BOOT, (_match, key: string) => `${key}${SEED_ON_BOOT_EXPRESSION}`)
}

/**
 * A dev script the rewrite must pair with: `bun --hot bin/serve.ts` sets no
 * NODE_ENV, so once seeding is allowed by name it would stop seeding. A script
 * that names NODE_ENV itself, or runs anything else, is the author's.
 */
export function withDevelopmentNodeEnv(script: string): string | null {
  if (script.includes('NODE_ENV') || !/^bun --hot \S*serve\.ts\b/.test(script)) return null
  return `NODE_ENV=development ${script}`
}
