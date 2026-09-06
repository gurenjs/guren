import { Router, authorizeMiddleware, requireAuthenticated } from '@guren/core'

import AgentOpsController from '../app/Http/Controllers/AgentOpsController'
import ApprovalController from '../app/Http/Controllers/ApprovalController'
import TicketController from '../app/Http/Controllers/TicketController'
import {
  ApprovalIdParamSchema,
  PruneApprovalsSchema,
  ResolveApprovalSchema,
} from '../app/Http/Validators/ApprovalValidator'
import {
  CreateTicketSchema,
  ListTicketsQuerySchema,
  TicketIdParamSchema,
  TicketListResponseSchema,
  TicketResponseSchema,
} from '../app/Http/Validators/TicketValidator'

/**
 * Both callers satisfy this: an operator's bearer token, and the principal the
 * agent pipeline installs on the request it dispatches in-process.
 */
const authenticated = requireAuthenticated()

/** The operator surface: a person, never the agent principal. */
const operator = [authenticated, authorizeMiddleware('operate')]

export function registerApiRoutes(router: Router): void {
  router.get('/health', () => Response.json({ ok: true }))

  router.get(
    '/tickets',
    {
      name: 'tickets.index',
      middlewares: [authenticated],
      query: ListTicketsQuerySchema,
      output: TicketListResponseSchema,
      agent: { description: 'List tickets, optionally filtered by status.' },
    },
    [TicketController, 'index'],
  )

  router.post(
    '/tickets',
    {
      name: 'tickets.store',
      middlewares: [authenticated],
      body: CreateTicketSchema,
      output: TicketResponseSchema,
    },
    [TicketController, 'store'],
  )

  router.post(
    '/tickets/:id/close',
    {
      name: 'tickets.close',
      // Authorization, not just authentication: a mutating agent tool that
      // carried only `authenticated` would hand every authenticated caller the
      // whole tool, and `guren check` fails it. The ability is defined in
      // `app/Providers/AuthProvider.ts`.
      middlewares: [authenticated, authorizeMiddleware('close-ticket')],
      params: TicketIdParamSchema,
      output: TicketResponseSchema,
      agent: {
        description: 'Close one ticket by id. Requires a human approval before it runs.',
        approval: 'required',
      },
    },
    [TicketController, 'close'],
  )

  // The operator surface. No `agent` metadata, so none of it is a tool: the
  // agent could not resolve an approval of its own even if it were scoped to.
  router.get('/approvals', { name: 'approvals.index', middlewares: operator }, [
    ApprovalController,
    'index',
  ])

  router.post(
    '/approvals/:id/approve',
    {
      name: 'approvals.approve',
      middlewares: operator,
      params: ApprovalIdParamSchema,
      body: ResolveApprovalSchema,
    },
    [ApprovalController, 'approve'],
  )

  router.post(
    '/approvals/:id/reject',
    {
      name: 'approvals.reject',
      middlewares: operator,
      params: ApprovalIdParamSchema,
      body: ResolveApprovalSchema,
    },
    [ApprovalController, 'reject'],
  )

  // Housekeeping, not part of the queue contract: the table only grows, and
  // an operator decides when a settled request stops being audit trail.
  router.post(
    '/approvals/prune',
    { name: 'approvals.prune', middlewares: operator, body: PruneApprovalsSchema },
    [ApprovalController, 'prune'],
  )

  // Not `/agents/...`: the generated worker gives that prefix to the agents
  // SDK's router, so a route registered under it never reaches this app.
  router.get('/ops/agents/triager', { name: 'agents.triager.show', middlewares: operator }, [
    AgentOpsController,
    'show',
  ])

  router.post('/ops/agents/triager/sweep', { name: 'agents.triager.sweep', middlewares: operator }, [
    AgentOpsController,
    'sweep',
  ])
}

export default registerApiRoutes
