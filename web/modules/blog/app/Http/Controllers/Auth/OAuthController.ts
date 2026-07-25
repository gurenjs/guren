import { Controller, ValidationException, type OAuthManager } from '@guren/core'
import { z } from 'zod'
import { User } from '../../../Models/User.js'
import { assertAllowlistedAdmin } from '../../../Services/admin-allowlist.js'

const CallbackQuerySchema = z.object({
  code: z.string(),
  state: z.string(),
})

export default class OAuthController extends Controller {
  private oauth(): OAuthManager {
    return this.make<OAuthManager>('oauth')
  }

  // Note: not named `redirect` — that would shadow the base
  // Controller.redirect() helper used below.
  async redirectToProvider(): Promise<Response> {
    const { url } = await this.oauth().authorize('github', {
      redirectTo: this.request.query('redirectTo') ?? undefined,
    })

    return this.redirect(url)
  }

  async callback(): Promise<Response> {
    const { code, state } = this.validateQuery(CallbackQuerySchema)

    const { profile, redirectTo } = await this.oauth().handleCallback('github', { code, state })

    // Enforced before any account lookup or creation: this is a single-admin
    // blog, so arbitrary GitHub users must never get accounts.
    assertAllowlistedAdmin(profile.id, process.env.BLOG_ADMIN_GITHUB_ID)

    // Lowercased to keep lookups stable; provider casing isn't guaranteed
    // to be consistent across logins.
    const email = profile.email?.toLowerCase()
    if (!email) {
      throw ValidationException.withMessages({ message: 'GitHub did not return an email address.' })
    }

    let [user] = await User.where({ githubId: profile.id })

    if (!user) {
      const [existingByEmail] = await User.where({ email })
      if (existingByEmail) {
        throw ValidationException.withMessages({
          message: 'An account with this email already exists. Sign in with the method you originally used.',
        })
      }

      // OAuth accounts are passwordless: no synthetic password is hashed —
      // password login rejects accounts without a hash, and hashing here
      // would blow the request CPU budget on Cloudflare Workers.
      user = await User.create({
        name: profile.name ?? email,
        email,
        githubId: profile.id,
      })
    }

    this.auth.session()?.regenerate()
    await this.auth.login(user)

    return this.redirect(redirectTo ?? '/admin')
  }

  async logout(): Promise<Response> {
    await this.auth.logout()
    this.auth.session()?.invalidate()

    return this.redirect('/blog')
  }
}
