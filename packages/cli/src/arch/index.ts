export type ArchGlobs = string | string[]

export interface ArchLayers {
  [layerName: string]: ArchGlobs
}

export type ArchSeverity = 'fail' | 'warn'

export interface ArchRule {
  /** Layer name (declared in `layers`) or an inline glob this rule applies to. */
  from: string
  /** Layer name(s) or inline glob(s) that files in `from` must not import. */
  disallow?: string | string[]
  /** Bare package specifiers (e.g. `'drizzle-orm'`) that files in `from` must not import. */
  disallowPackages?: string | string[]
  /** Custom suggestion shown on violation, replacing the default message. */
  message?: string
  /**
   * `'fail'` breaks `guren check`; `'warn'` surfaces the violation without
   * failing. Use `'warn'` while rolling out a new boundary on an existing
   * codebase, then promote to `'fail'` once violations reach zero.
   * @default 'fail'
   */
  severity?: ArchSeverity
}

export interface ArchRuleSet {
  /** Maps a layer name to one or more globs, matched against project-relative paths. */
  layers?: ArchLayers
  rules: ArchRule[]
}

/**
 * Identity function that gives `guren.arch.ts` type-checking and editor
 * autocomplete. Exported from the `@guren/cli/arch` subpath — not the CLI's
 * main entry or `@guren/core` — because architecture rules are a build-time
 * concern with no runtime footprint, the same reasoning that keeps
 * `drizzle.config.ts` importing from `drizzle-kit` rather than `drizzle-orm`.
 *
 * @example
 * ```typescript
 * import { defineArchRules } from '@guren/cli/arch'
 *
 * export default defineArchRules({
 *   layers: {
 *     domain: 'app/Domain/**',
 *     http: 'app/Http/**',
 *   },
 *   rules: [
 *     { from: 'domain', disallow: ['http'] },
 *     { from: 'http', disallowPackages: ['drizzle-orm'] },
 *   ],
 * })
 * ```
 */
export function defineArchRules(config: ArchRuleSet): ArchRuleSet {
  return config
}
