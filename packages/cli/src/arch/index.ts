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
   * "Import" means a *runtime* dependency: type-only imports compile away and
   * are not analysed unless {@link ArchRule.includeTypeImports} is set.
   */
  disallow?: string | string[]
  /** Bare package specifiers (e.g. `'drizzle-orm'`) that files in `from` must not import. */
  disallowPackages?: string | string[]
  /** Custom suggestion shown on violation, replacing the default message. */
  message?: string
  /**
   * `'fail'` breaks `guren check`; `'warn'` surfaces the violation without
   * failing.
   * @default 'fail'
   */
  severity?: ArchSeverity
  /**
   * Also treat type-only imports as boundary crossings for this rule. Off by
   * default: a type-only import leaves no trace in the bundle. Overrides
   * {@link ArchRuleSet.includeTypeImports}.
   * @default false
   */
  includeTypeImports?: boolean
}

export interface ArchRuleSet {
  /** Maps a layer name to one or more globs, matched against project-relative paths. */
  layers?: ArchLayers
  rules: ArchRule[]
  /**
   * Default for {@link ArchRule.includeTypeImports} across every rule in this
   * set; a rule's own setting wins. Covers only the rules declared here — the
   * zero-config `modules/` boundary rules always analyse runtime imports only.
   * @default false
   */
  includeTypeImports?: boolean
}

/**
 * Identity function that gives `guren.arch.ts` type-checking and autocomplete.
 * Exported from the `@guren/cli/arch` subpath, not `@guren/core`: architecture
 * rules are build-time only. Rules analyse static `import`/`export ... from`
 * declarations; type-only imports are skipped unless `includeTypeImports` is set,
 * and dynamic `import()` is never followed.
 */
export function defineArchRules(config: ArchRuleSet): ArchRuleSet {
  return config
}
