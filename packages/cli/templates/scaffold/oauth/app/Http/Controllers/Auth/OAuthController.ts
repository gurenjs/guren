import { Controller, type OAuthManager } from '@guren/core'

type SupportedProvider = 'github' | 'google' | 'discord'

const SUPPORTED_PROVIDERS = new Set<SupportedProvider>(['github', 'google', 'discord'])

export default class OAuthController extends Controller {
  private oauth(): OAuthManager {
    return this.make<OAuthManager>('oauth')
  }

  // Note: not named `redirect` — that would shadow the base
  // Controller.redirect() helper used below.
  async redirectToProvider(): Promise<Response> {
    const provider = this.validateProvider(this.request.param('provider'))

    // Passing the session ties `state` to this browser: the manager keeps a
    // binding in it that the callback must present back. Without it an
    // attacker could authorize their own account, keep the `code` unconsumed,
    // and walk a visitor through the callback — logging that visitor into the
    // attacker's account.
    // `?redirectTo=` is user input — the manager only keeps app-relative
    // paths (or hosts allowlisted via stateConfig.allowedRedirectHosts).
    const { url } = await this.oauth().authorize(provider, {
      redirectTo: this.request.query('redirectTo'),
      session: this.auth.session(),
    })
    return this.redirect(url)
  }

  async callback(): Promise<Response> {
    const provider = this.validateProvider(this.request.param('provider'))
    const code = this.request.query('code')
    const state = this.request.query('state')

    if (!code || !state) {
      return this.json({ error: 'Missing OAuth callback parameters.' }, { status: 400 })
    }

    // Replace this with your own account linking: look the user up by
    // profile.email, create one when missing, then `await this.auth.login(user)`
    // and finish with `return this.redirect(redirectTo ?? '/')` —
    // `redirectTo` is already sanitized against open redirects. Refuse to
    // create an account when `profile.emailVerified === false`: the provider
    // is saying it never checked that the address belongs to this user.
    const { profile, redirectTo } = await this.oauth().handleCallback(provider, {
      code,
      state,
      session: this.auth.session(),
    })
    return this.json({ provider, profile, redirectTo }, { status: 200 })
  }

  private validateProvider(value: string | undefined): SupportedProvider {
    if (value && SUPPORTED_PROVIDERS.has(value as SupportedProvider)) {
      return value as SupportedProvider
    }
    throw new Error(`Unsupported OAuth provider: ${value ?? '(missing)'}`)
  }
}
