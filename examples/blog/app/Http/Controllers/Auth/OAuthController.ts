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

interface GitHubEmail {
  email: string
  primary: boolean
  verified: boolean
}

// GitHub's /user endpoint returns `email: null` whenever the account's email
// is set to private, even with the `user:email` scope granted — the primary
// verified address is only available from this separate endpoint.
async function fetchGitHubPrimaryEmail(accessToken: string): Promise<string | undefined> {
  const response = await fetch('https://api.github.com/user/emails', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'guren-blog',
    },
  })

  if (!response.ok) {
    return undefined
  }

  const emails = (await response.json()) as GitHubEmail[]
  return emails.find((entry) => entry.primary && entry.verified)?.email
}

export default class OAuthController extends Controller {
  private oauth(): OAuthManager {
    return this.make<OAuthManager>('oauth')
  }

  // Note: not named `redirect` — that would shadow the base
  // Controller.redirect() helper used below.
  async redirectToProvider(): Promise<Response> {
    const { provider } = this.validateParams(ProviderParamSchema)

    const { url } = await this.oauth().authorize(provider, {
      redirectTo: this.request.query('redirectTo') ?? undefined,
    })

    return this.redirect(url)
  }

  async callback(): Promise<Response> {
    const { provider } = this.validateParams(ProviderParamSchema)
    const { code, state } = this.validateQuery(CallbackQuerySchema)

    const { profile, redirectTo } = await this.oauth().handleCallback(provider, { code, state })

    const resolvedEmail = (
      profile.email ?? (provider === 'github' ? await fetchGitHubPrimaryEmail(profile.token.accessToken) : undefined)
    )?.toLowerCase()

    if (!resolvedEmail) {
      throw ValidationException.withMessages({ message: 'This provider did not return an email address.' })
    }

    let [user] = await User.where(identityWhere(provider, profile.id))

    if (!user) {
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
        // The provider already vouches for this address (GitHub's fallback
        // above only accepts primary+verified emails; Google's userinfo
        // email comes from a verified account) — making the user click a
        // verification link we never send would just strand them at
        // /verify-email.
        emailVerifiedAt: new Date(),
        ...identityWhere(provider, profile.id),
      })
    }

    this.auth.session()?.regenerate()
    await this.auth.login(user)

    return this.redirect(redirectTo ?? '/dashboard')
  }
}
