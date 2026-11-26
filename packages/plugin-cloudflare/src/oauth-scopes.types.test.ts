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

type TokenExchange = NonNullable<Options['tokenExchangeCallback']>
type TokenExchangeOptions = Parameters<TokenExchange>[0]
type TokenExchangeResult = Exclude<Awaited<ReturnType<TokenExchange>>, void>

// What the generated callback reads and answers with. A rename upstream would
// leave every narrowed token carrying its whole grant again, with no error.
const tokenExchange: AcceptsOption<Options, 'tokenExchangeCallback', TokenExchange> = true
const grantScope: AcceptsOption<TokenExchangeOptions, 'scope', string[]> = true
const tokenScope: AcceptsOption<TokenExchangeOptions, 'requestedScope', string[]> = true
const grantProps: AcceptsOption<TokenExchangeOptions, 'props', object> = true
const tokenProps: AcceptsOption<TokenExchangeResult, 'accessTokenProps', object> = true

describe('the advertised OAuth scope options', () => {
  test('are named as the provider declares them (checked at typecheck time)', () => {
    expect(resourceScopes && serverScopes).toBe(true)
  })
})

describe('the token exchange callback', () => {
  test('reads and answers the fields the provider declares (checked at typecheck time)', () => {
    expect(tokenExchange && grantScope && tokenScope && grantProps && tokenProps).toBe(true)
  })
})
