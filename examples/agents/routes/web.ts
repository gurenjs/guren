import { Router, authorizeMiddleware, requireAuthenticated } from '@guren/core'

import ConsoleController from '../app/Http/Controllers/Console/ConsoleController'
import SessionController from '../app/Http/Controllers/Console/SessionController'
import { ApprovalIdParamSchema } from '../app/Http/Validators/ApprovalValidator'
import { OperatorLoginSchema } from '../app/Http/Validators/ConsoleValidator'
import registerApiRoutes from './api'

/**
 * A person in a browser, holding a session cookie — never a bearer token and
 * never the agent principal. `authorizeMiddleware('operate')` is what says so;
 * `requireAuthenticated` alone would also admit a token-bearing caller.
 */
const consoleOperator = [
  requireAuthenticated({ redirectTo: '/login' }),
  authorizeMiddleware('operate'),
]

/**
 * The app's one registrar, so `guren check` can reach `routes/api.ts` from the
 * entry `createApp({ routes })` names. The JSON surface is mounted unchanged:
 * its routes carry the `agent` metadata the tool catalogue is derived from, and
 * an Inertia response on one of them would stop being a tool result.
 */
export function registerWebRoutes(router: Router): void {
  registerApiRoutes(router)

  router.get('/login', { name: 'console.login' }, [SessionController, 'show'])
  router.post('/login', { name: 'console.login.store', body: OperatorLoginSchema }, [
    SessionController,
    'store',
  ])
  router.post('/logout', { name: 'console.logout', middlewares: consoleOperator }, [
    SessionController,
    'destroy',
  ])

  router.get('/', { name: 'console.index', middlewares: consoleOperator }, [
    ConsoleController,
    'index',
  ])

  // Under `/console/`, so the JSON operator API keeps the bare `/approvals/...`
  // paths the README's curl walkthrough and any existing script already use.
  router.post(
    '/console/approvals/:id/approve',
    { name: 'console.approvals.approve', middlewares: consoleOperator, params: ApprovalIdParamSchema },
    [ConsoleController, 'approve'],
  )

  router.post(
    '/console/approvals/:id/reject',
    { name: 'console.approvals.reject', middlewares: consoleOperator, params: ApprovalIdParamSchema },
    [ConsoleController, 'reject'],
  )

  router.post('/console/sweep', { name: 'console.sweep', middlewares: consoleOperator }, [
    ConsoleController,
    'sweep',
  ])
}

export default registerWebRoutes
