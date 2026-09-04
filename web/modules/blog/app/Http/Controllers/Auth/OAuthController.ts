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

  // Not named `redirect`: that would shadow Controller.redirect(), used below.
  async redirectToProvider(): Promise<Response> {
    // Passing the session ties `state` to this browser. Without it an attacker
    // could authorize their own account, keep the `code` unconsumed, and walk a
    // visitor's browser through the callback.
    const { url } = await this.oauth().authorize('github', {
      redirectTo: this.request.query('redirectTo') ?? undefined,
      session: this.auth.session(),
    })

    return this.redirect(url)
  }

  async callback(): Promise<Response> {
    const { code, state } = this.validateQuery(CallbackQuerySchema)

    const { profile, redirectTo } = await this.oauth().handleCallback('github', {
      code,
      state,
      session: this.auth.session(),
    })

    // Before any lookup or creation: a single-admin blog must never create
    // accounts for arbitrary GitHub users.
    assertAllowlistedAdmin(profile.id, process.env.BLOG_ADMIN_GITHUB_ID)

    // Lowercased: provider casing is not guaranteed stable across logins.
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

      // Passwordless: password login rejects accounts with no hash, and hashing
      // one here would blow the request CPU budget on Workers.
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
