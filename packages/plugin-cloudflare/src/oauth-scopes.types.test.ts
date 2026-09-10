import { describe, expect, test } from 'bun:test'
import type { OAuthProviderOptions } from '@cloudflare/workers-oauth-provider'

/**
 * `renderOAuthProvider` emits its options as a *string*, so nothing typechecks
 * the field names carrying the advertised scopes: misspell one, or let the
 * provider rename it, and the option is ignored in silence. `keyof` rather than
 * assignability — an object literal is assignable to a type that never declared
 * its keys, so only this shape fails when a name stops existing.
 */
type AcceptsOption<O, K extends string, V> = K extends keyof O
  ? (V extends O[K] ? true : never)
  : never

type Options = OAuthProviderOptions<{ OAUTH_KV: unknown }>
type ResourceMetadata = NonNullable<Options['resourceMetadata']>

// RFC 9728 Protected Resource Metadata, and the `scope` on the 401 challenge —
// the two places the MCP scope selection strategy reads.
const resourceScopes: AcceptsOption<ResourceMetadata, 'scopes_supported', string[]> = true
// RFC 8414 authorization server metadata.
const serverScopes: AcceptsOption<Options, 'scopesSupported', string[]> = true

describe('the advertised OAuth scope options', () => {
  test('are named as the provider declares them (checked at typecheck time)', () => {
    expect(resourceScopes && serverScopes).toBe(true)
  })
})
