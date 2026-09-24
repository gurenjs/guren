/**
 * Whether one optional manifest section can be trusted (RFC 0026 §5), shared by every
 * check that reads the introspected app. Stricter than the server's `readSection()`
 * (`packages/server/src/introspection/manifest.ts`), which unverifies only an
 * unbound key: here any provider that threw unverifies every section, since
 * `auth` is bound in the `Application` constructor and configured inside a provider.
 * A check with a static path falls back to it for an unverified section; only a
 * fact with none becomes a `-unverified` warning.
 */
import type { AppManifest } from '@guren/server'

import type { CheckResult } from './check-result'
import type { Introspection } from './introspect'

export type ManifestSectionKey = 'auth' | 'session' | 'cache' | 'storage' | 'queue' | 'attachments'

/** What the app reported (`undefined` for a section it does not configure), or why that cannot be trusted. */
export type ManifestSection<T> = { status: 'described'; value: T } | { status: 'unverified'; reason: string }

/** The remedy every `-unverified` verdict starts with. */
export const UNVERIFIED_SECTION_FIX = 'Run `bunx guren introspect` and make the provider it names register cleanly; a provider that needs a runtime binding can implement `introspect()` to bind only what the manifest describes.'

export function readManifestSection<K extends ManifestSectionKey>(
  manifest: AppManifest,
  key: K,
): ManifestSection<AppManifest[K]> {
  const thrown = thrownProviders(manifest)
  if (thrown) return { status: 'unverified', reason: thrown }
  // A config left unbound for an env key this environment does not set. Checked before the value:
  // an unbound `session` is still described, as the middleware's `source: 'none'` fallback.
  // A warning with no `key` is an older server's, and may be any section.
  const config = manifest.warnings.find((warning) => warning.code === 'config-unverified' && (warning.key ?? key) === key)
  if (config && !manifest.bindings.includes(key)) return { status: 'unverified', reason: config.message.replace(/\.$/u, '') }
  const value = manifest[key]
  if (value !== undefined) return { status: 'described', value }
  const deferred = manifest.providers.find((provider) => provider.register === 'skipped' && provider.provides.includes(key))
  if (deferred) {
    return { status: 'unverified', reason: `"${key}" is supplied by the deferred ${deferred.name}, which registers only after boot` }
  }
  if (manifest.bindings.includes(key)) {
    return { status: 'unverified', reason: `"${key}" is bound, but the introspected app could not describe it` }
  }
  return { status: 'described', value }
}

/** Why nothing a provider registers can be trusted, or `undefined` when every provider registered. */
function thrownProviders(manifest: AppManifest): string | undefined {
  const thrown = manifest.providers.filter((provider) => provider.register === 'threw').map((provider) => provider.name)
  return thrown.length > 0 ? `${thrown.join(', ')} threw in register(), so what it configures is unknown` : undefined
}

export function mapSection<T, U>(section: ManifestSection<T>, map: (value: T) => U): ManifestSection<U> {
  return section.status === 'described' ? { status: 'described', value: map(section.value) } : section
}

/** A section as a check with a static path reads it: the manifest's value, or source with the reason the manifest could not be used. */
export type IntrospectedSection<T> =
  | { status: 'described'; value: T; manifest: AppManifest }
  | { status: 'static'; reason?: string }

/** The run's introspection, started on first call, or why this run judges from source without one. */
export type IntrospectSource = (() => Promise<Introspection>) | { skipped: string }

/**
 * The section `key`, asking for the introspection only now, so the check calling this is what
 * starts the child. No source (`--no-introspect`, an in-process run) and a failed run give no
 * reason: `guren check` reports a failure once, as `introspection-unavailable`.
 */
export async function introspectedSection<K extends ManifestSectionKey>(
  introspect: IntrospectSource | undefined,
  key: K,
): Promise<IntrospectedSection<AppManifest[K]>> {
  const routes = await introspectedRoutes(introspect)
  if (routes.status === 'static') return routes
  const section = readManifestSection(routes.manifest, key)
  return section.status === 'described'
    ? { status: 'described', value: section.value, manifest: routes.manifest }
    : { status: 'static', reason: section.reason }
}

/**
 * The introspected app's routes, for a check that judges them (RFC 0026 §5), asked for only now.
 * A provider that threw falls back to source like a section does: it may have been the one to
 * register a middleware alias the routes name, which the manifest would then call unresolved.
 */
export async function introspectedRoutes(
  introspect: IntrospectSource | undefined,
): Promise<{ status: 'described'; manifest: AppManifest } | { status: 'static'; reason?: string }> {
  if (introspect && 'skipped' in introspect) return { status: 'static', reason: introspect.skipped }
  const introspection = await introspect?.()
  if (introspection?.status !== 'ok') return { status: 'static' }
  const thrown = thrownProviders(introspection.manifest)
  return thrown ? { status: 'static', reason: thrown } : { status: 'described', manifest: introspection.manifest }
}

/** The remedy the one `introspection-unavailable` line carries, in `guren check` and `guren audit` alike. */
export const INTROSPECTION_UNAVAILABLE_FIX = 'Run `bunx guren introspect` to see the failure, or pass --no-introspect to skip it.'

/** That line's message: the failure's first line, then what the command judged instead. */
export function introspectionUnavailableMessage(failure: Extract<Introspection, { status: 'failed' }>, judgedInstead: string): string {
  const reason = failure.message.split('\n')[0]!.replace(/\.?$/u, '.')
  return `The app could not be introspected (${failure.reason}): ${reason} ${judgedInstead}`
}

/** Results a check judged from source, naming why the manifest was not used when there is a reason. */
export function judgedFromSource(results: CheckResult[], reason?: string): CheckResult[] {
  return results.map((result) => ({
    ...result,
    ...(reason ? { message: `${result.message} Judged from source: ${reason}.` } : {}),
    evidence: 'static',
  }))
}

/** Results judged with the introspected app; one that set its own evidence (a fact read from source) keeps it. */
export function judgedFromManifest(results: CheckResult[]): CheckResult[] {
  return results.map((result) => ({ evidence: 'manifest', ...result }))
}

/** Manifest verdicts win per key; a source verdict the manifest did not judge (another config file) stays. */
export function mergeVerdicts(manifest: CheckResult[], source: CheckResult[]): CheckResult[] {
  const judged = new Set(manifest.map((result) => result.key))
  return [...manifest, ...source.filter((result) => !judged.has(result.key))]
}

/** The one element of a list, else `undefined`: a manifest fact goes to a config only when no other could own it. */
export function sole<T>(items: readonly T[]): T | undefined {
  return items.length === 1 ? items[0] : undefined
}
