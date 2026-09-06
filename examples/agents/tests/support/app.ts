import { rmSync } from 'node:fs'

import { agentApprovalFingerprint, buildAgentApprovalRequest, createApiToken } from '@guren/core'
import type { AgentApprovalRequest, AgentPrincipal } from '@guren/core'
import { TestApp } from '@guren/testing'

import '../setup'
import { User } from '../../app/Models/User'
import { apiTokenStore } from '../../app/Services/DrizzleApiTokenStore'
import { approvalStore } from '../../app/Services/DrizzleApprovalStore'
import { migrateDatabase } from '../../config/database'
import app from '../../src/app'

/** The principal an agent call arrives as — the one `AuthProvider` matches. */
export const agentPrincipal: AgentPrincipal = { kind: 'service', id: 'agent:triager:main' }

let booted: Promise<TestApp> | undefined

/**
 * One booted application per process, over a database this run owns. The file
 * is removed first: a leftover from a previous run would carry its seed rows,
 * making counts depend on how often the suite has been run.
 */
export function testApp(): Promise<TestApp> {
  booted ??= (async () => {
    rmSync(process.env.SQLITE_DATABASE_PATH!, { force: true })
    await migrateDatabase()
    return TestApp.fromApp(app)
  })()
  return booted
}

/** A bearer token for a fresh operator, the way `db/seeders` mints the demo's. */
export async function operatorToken(name = 'test-operator'): Promise<string> {
  const user = (await User.create({
    name,
    email: `${crypto.randomUUID()}@example.test`,
  })) as { id: number }
  const { plainTextToken } = await createApiToken(apiTokenStore, { name, userId: user.id })
  return plainTextToken
}

/**
 * A `tickets.close` call parked on a human, as the tool gate would file it.
 * @param at When the request was made. The default TTL is an hour, so a `at`
 *   further back than that produces a row that is expired but stored `pending`.
 */
export async function parkApproval(
  input: Record<string, unknown>,
  at = new Date(),
): Promise<AgentApprovalRequest> {
  await testApp()
  const request = buildAgentApprovalRequest(
    {
      tool: 'tickets.close',
      input,
      fingerprint: await agentApprovalFingerprint(input),
      principal: agentPrincipal,
    },
    at,
  )
  await approvalStore.create(request)
  return request
}
