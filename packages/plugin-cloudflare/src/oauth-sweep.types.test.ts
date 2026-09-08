import { describe, expect, test } from 'bun:test'
import type { KVNamespace } from '@cloudflare/workers-types'
import type OAuthProvider from '@cloudflare/workers-oauth-provider'
import type { OAuthPurgerLike, OAuthSweepKvLike } from './oauth-sweep'

// Compile-time contract: the real bindings must satisfy the structural views the
// sweep is written against, so an upstream rename fails `tsc --noEmit` here
// instead of the generated worker at runtime.
type Assignable<From, To> = From extends To ? true : never

type Env = { OAUTH_KV: KVNamespace }
const kvIsKvLike: Assignable<KVNamespace, OAuthSweepKvLike> = true
const providerIsPurger: Assignable<OAuthProvider<Env>, OAuthPurgerLike<Env>> = true

// And the other direction for what the sweep *passes in*: every option it hands
// to purgeExpiredData must be a legal option for the real provider.
type PurgeOptionsOf<P> = P extends { purgeExpiredData(env: never, options?: infer O): unknown } ? O : never
const purgeOptionsFit: Assignable<PurgeOptionsOf<OAuthPurgerLike<Env>>, PurgeOptionsOf<OAuthProvider<Env>>> = true

describe('the OAuth sweep binding types', () => {
  test('are satisfied by the real KVNamespace and OAuthProvider (checked at typecheck time)', () => {
    expect(kvIsKvLike && providerIsPurger && purgeOptionsFit).toBe(true)
  })
})
