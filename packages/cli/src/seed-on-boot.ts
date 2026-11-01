/**
 * The one spelling of boot-time seeding in `config/database.ts`, and the rewrite
 * `guren upgrade` applies to the denylist form older scaffolds shipped. Seeders
 * write demo accounts, so seeding is allowed by name: an unset NODE_ENV must not
 * seed. `packages/create-app/templates/database/` spells the same expression.
 */
export const SEED_ON_BOOT_EXPRESSION = "process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'"

export const SEED_ON_BOOT_OPTION = `{ seedOnBoot: ${SEED_ON_BOOT_EXPRESSION} }`

const LEGACY = String.raw`(\bseedOnBoot\s*:\s*)process\.env\.NODE_ENV\s*!==?\s*(['"])production\2`
const LEGACY_ANYWHERE = new RegExp(LEGACY)
// Only the whole value: `!== 'production' && …` would change meaning under the new `||`.
const LEGACY_WHOLE_VALUE = new RegExp(`${LEGACY}(?=\\s*(?:[,}]|$))`, 'g')
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/
const DEV_SCRIPTS = ['dev:server', 'dev'] as const

export type SeedOnBootPlan =
  | { readonly kind: 'none' }
  | { readonly kind: 'manual'; readonly reason: string }
  | { readonly kind: 'rewrite'; readonly config: string; readonly script: { readonly name: string; readonly command: string } | null }

/**
 * The config rewrite always comes with a dev script that sets NODE_ENV=development
 * (an existing one, or one prefixed here), or `bun run dev` would stop seeding.
 * An env prefix reaches only the first command, so a compound script is manual.
 */
export function planSeedOnBootUpgrade(source: string, scripts: Readonly<Record<string, string>> | undefined): SeedOnBootPlan {
  const lines = source.split('\n')
  const legacy = lines.filter((line) => !COMMENT_LINE.test(line) && LEGACY_ANYWHERE.test(line))
  if (legacy.length === 0) return { kind: 'none' }
  if (legacy.some((line) => LEGACY_ANYWHERE.test(line.replace(LEGACY_WHOLE_VALUE, '')))) {
    return { kind: 'manual', reason: "the seedOnBoot value goes on past `!== 'production'`, so rewriting it would change what the rest means" }
  }
  const config = lines
    .map((line) => (COMMENT_LINE.test(line) ? line : line.replace(LEGACY_WHOLE_VALUE, (_match, key: string) => `${key}${SEED_ON_BOOT_EXPRESSION}`)))
    .join('\n')

  const present = DEV_SCRIPTS.flatMap((name) => (scripts?.[name] === undefined ? [] : [{ name, command: scripts[name] }]))
  if (present.some(({ command }) => /\bNODE_ENV=development\b/.test(command) || /\bguren dev\b/.test(command))) {
    return { kind: 'rewrite', config, script: null }
  }
  const launcher = present.find(({ command }) => /\bserve\.ts\b/.test(command))
  if (!launcher) return { kind: 'manual', reason: 'no `dev` or `dev:server` script runs serve.ts' }
  if (launcher.command.includes('NODE_ENV') || /&&|\|\||[;|&]/.test(launcher.command)) {
    return { kind: 'manual', reason: `the \`${launcher.name}\` script is not one command that leaves NODE_ENV unset, so it cannot be prefixed with NODE_ENV=development` }
  }
  return { kind: 'rewrite', config, script: { name: launcher.name, command: `NODE_ENV=development ${launcher.command}` } }
}
