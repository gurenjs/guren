import { Controller, ValidationException, type OAuthManager } from '@guren/core'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { User, type UserRecord } from '../../../Models/User.js'

const ProviderParamSchema = z.object({
  provider: z.enum(['github', 'google']),
})

const CallbackQuerySchema = z.object({
  code: z.string(),
  state: z.string(),
})

type OAuthProvider = z.infer<typeof ProviderParamSchema>['provider']

function identityWhere(provider: OAuthProvider, profileId: string): Partial<UserRecord> {
  const identities: Record<OAuthProvider, Partial<UserRecord>> = {
    github: { githubId: profileId },
    google: { googleId: profileId },
  }
  return identities[provider]
}

export default class OAuthController extends Controller {
  private oauth(): OAuthManager {
    return this.make<OAuthManager>('oauth')
  }

  // Note: not named `redirect` — that would shadow the base
  // Controller.redirect() helper used below.
  async redirectToProvider(): Promise<Response> {
    const { provider } = this.validateParams(ProviderParamSchema)

    // Passing the session ties `state` to this browser: the manager keeps a
    // binding in it that the callback must present back. Without it an
    // attacker could authorize their own account, hold the `code`, and walk a
    // visitor through the callback to log them into the attacker's account.
    const { url } = await this.oauth().authorize(provider, {
      redirectTo: this.request.query('redirectTo') ?? undefined,
      session: this.auth.session(),
    })

    return this.redirect(url)
  }

  async callback(): Promise<Response> {
    const { provider } = this.validateParams(ProviderParamSchema)
    const { code, state } = this.validateQuery(CallbackQuerySchema)

    const { profile, redirectTo } = await this.oauth().handleCallback(provider, {
      code,
      state,
      session: this.auth.session(),
    })

    // GitHub accounts with a private email are handled upstream:
    // createGitHubOAuthProviderConfig falls back to /user/emails, so
    // profile.email is already populated whenever one is obtainable.
    const resolvedEmail = profile.email?.toLowerCase()

    if (!resolvedEmail) {
      throw ValidationException.withMessages({ message: 'This provider did not return an email address.' })
    }

    let [user] = await User.where(identityWhere(provider, profile.id))

    if (!user) {
      // Returning an email is not a claim that the provider checked it — the
      // provider reports that separately, and profile.emailVerified carries
      // the answer. Creating an account from an address the provider says it
      // never verified would let it claim an email it does not own, and the
      // collision check below would then turn the real owner away for good.
      // Only an explicit false is refused: providers that send no signal at
      // all (GitHub's /user) leave this undefined. Checked only on the create
      // path, so an already-linked account is not locked out if its provider
      // status changes later.
      if (profile.emailVerified === false) {
        throw ValidationException.withMessages({
          message: 'Your provider has not verified this email address. Verify it with the provider and try again.',
        })
      }

      const [existingByEmail] = await User.where({ email: resolvedEmail })
      if (existingByEmail) {
        throw ValidationException.withMessages({
          message: 'An account with this email already exists. Sign in with your password instead.',
        })
      }

      // No password was supplied by the user — generate a random one so the
      // account still satisfies AuthenticatableModel's hashing pipeline.
      // It's never surfaced to the user and can't realistically be guessed.
      user = await User.create({
        name: profile.name ?? resolvedEmail,
        email: resolvedEmail,
        password: randomUUID(),
        // The address got past the check above — either the provider vouches
        // for it, or it came from GitHub's fallback, which only accepts
        // primary+verified emails. Making the user click a verification link
        // we never send would just strand them at /verify-email.
        emailVerifiedAt: new Date(),
        ...identityWhere(provider, profile.id),
      })
    }

    this.auth.session()?.regenerate()
    await this.auth.login(user)

    return this.redirect(redirectTo ?? '/dashboard')
  }
}
