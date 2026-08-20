export type ArchGlobs = string | string[]

export interface ArchLayers {
  [layerName: string]: ArchGlobs
}

export type ArchSeverity = 'fail' | 'warn'

export interface ArchRule {
  /** Layer name (declared in `layers`) or an inline glob this rule applies to. */
  from: string
  /**
   * Layer name(s) or inline glob(s) that files in `from` must not import.
   *
   * "Import" means a *runtime* dependency by default: type-only imports
   * (`import type`, `export type ... from`, and `import('...')` in a type
   * position) compile away and are not analysed unless
   * {@link ArchRule.includeTypeImports} is set.
   */
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
  /**
   * Also treat type-only imports (`import type { X } from '...'`,
   * `export type { X } from '...'`, and `import('...').X` in a type
   * position) as boundary crossings for this rule.
   *
   * Off by default: a type-only import leaves no trace in the bundle, and
   * sharing a type across layers (a DTO, a props interface) is a common,
   * benign pattern. Turn it on for boundaries meant to hold at the type
   * level too — a type dependency on another layer is often one refactor
   * away from a runtime one.
   *
   * Overrides {@link ArchRuleSet.includeTypeImports} for this rule.
   * @default false
   */
  includeTypeImports?: boolean
}

export interface ArchRuleSet {
  /** Maps a layer name to one or more globs, matched against project-relative paths. */
  layers?: ArchLayers
  rules: ArchRule[]
  /**
   * Default for {@link ArchRule.includeTypeImports} across every rule in
   * this set; a rule's own setting wins.
   *
   * Covers only the rules declared here. The zero-config module boundary
   * rules derived from a `modules/` directory are deliberately option-free
   * and always analyse runtime imports only.
   * @default false
   */
  includeTypeImports?: boolean
}

/**
 * Identity function that gives `guren.arch.ts` type-checking and editor
 * autocomplete. Exported from the `@guren/cli/arch` subpath — not the CLI's
 * main entry or `@guren/core` — because architecture rules are a build-time
 * concern with no runtime footprint, the same reasoning that keeps
 * `drizzle.config.ts` importing from `drizzle-kit` rather than `drizzle-orm`.
 *
 * Rules analyse *runtime* dependencies: static `import`/`export ... from`
 * declarations. Type-only imports compile away and are skipped by default —
 * set `includeTypeImports` (per rule, or on the set) to make a boundary
 * cover type dependencies as well. Dynamic `import()` expressions are never
 * followed.
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
