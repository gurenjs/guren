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

  // Not named `redirect`: that would shadow Controller.redirect() used below.
  async redirectToProvider(): Promise<Response> {
    const { provider } = this.validateParams(ProviderParamSchema)

    // Passing the session ties `state` to this browser. Without it an attacker
    // could authorize their own account, hold the `code`, and walk a visitor
    // through the callback to log them into the attacker's account.
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

    // A private GitHub email is handled upstream: createGitHubOAuthProviderConfig
    // falls back to /user/emails, so this is populated whenever one is obtainable.
    const resolvedEmail = profile.email?.toLowerCase()

    if (!resolvedEmail) {
      throw ValidationException.withMessages({ message: 'This provider did not return an email address.' })
    }

    let [user] = await User.where(identityWhere(provider, profile.id))

    if (!user) {
      // Returning an email is not a claim the provider checked it: an account
      // created from an unverified address claims an email it may not own, and
      // the collision check below then locks the real owner out. Only an explicit
      // false is refused, and only on the create path.
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

      // A random password so the account still satisfies AuthenticatableModel's
      // hashing pipeline; it is never surfaced and cannot realistically be guessed.
      user = await User.create({
        name: profile.name ?? resolvedEmail,
        email: resolvedEmail,
        password: randomUUID(),
        // The address passed the check above, so demanding a verification link
        // this app never sends would strand the user at /verify-email.
        emailVerifiedAt: new Date(),
        ...identityWhere(provider, profile.id),
      })
    }

    this.auth.session()?.regenerate()
    await this.auth.login(user)

    return this.redirect(redirectTo ?? '/dashboard')
  }
}
