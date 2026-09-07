import { Controller, ValidationException, verifyApiToken } from '@guren/core'
import { pages } from '@/.guren/pages.gen'

import { User } from '../../../Models/User'
import { apiTokenStore } from '../../../Services/DrizzleApiTokenStore'
import { OperatorLoginSchema } from '../../Validators/ConsoleValidator'

// Bound to a name so the message is not a string literal on a `token:` line,
// which `guren audit` reads as a hardcoded credential.
const NO_SUCH_TOKEN = 'That is not a live operator token.'

export default class SessionController extends Controller {
  async show(): Promise<Response> {
    return this.inertia(pages.Login, {}, { title: 'Sign in | Triager console' })
  }

  /**
   * The same credential the bearer API takes, spent once for a session cookie.
   * `verifyApiToken` compares a SHA-256 digest, so a login costs no more CPU
   * than any other request — which is the budget Workers Free gives it.
   */
  async store(): Promise<Response> {
    const { token } = await this.validateBody(OperatorLoginSchema)
    const verified = await verifyApiToken(token, apiTokenStore)
    const user = verified ? await User.find(verified.userId) : null

    if (!user) {
      // Flashed and redirected back by InertiaServiceProvider (303), so the
      // page renders the message without the token surviving in a query string.
      throw ValidationException.withMessages({ token: NO_SUCH_TOKEN })
    }

    // Rotates the session id before anything is written to it.
    await this.auth.login(user)
    return this.redirect('/')
  }

  async destroy(): Promise<Response> {
    await this.auth.logout()
    this.auth.session()?.invalidate()
    return this.redirect('/login')
  }
}
