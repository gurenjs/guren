/**
 * Builds the per-route security records of one checkout (RFC 0040 §3): the introspected routes'
 * middleware and contracts, and each action body's authorization and validate calls. Run without
 * the env files, so two exports read under one environment.
 */
import { sep } from 'node:path'

import {
  AUTH_CALL_PATTERN,
  AUTHORIZATION_CALL_PATTERN,
  VALIDATE_CALL_PATTERN,
  VALIDATE_MEMBER_CALL_PATTERN,
  controllerMethodFor,
  literalAuthorizationCalls,
  manifestRouteTargets,
  parseControllerMethods,
} from '../controller-methods'
import { CHECK_INTROSPECT_TIMEOUT_MS, introspectApp, type GraphRouteEntry } from '../introspect'
import { SECURITY_RECORD_VERSION, type ActionRecord, type RouteSecurityRecord, type SecurityRecords } from './security-records'

const CONTRACT_KEYS = ['params', 'query', 'body'] as const
const AUTHORIZATION_CALLS = new RegExp(AUTHORIZATION_CALL_PATTERN.source, 'g')

/** The records, or why the application could not be read: never a partial list. */
export async function readSecurityRecords(cwd: string): Promise<SecurityRecords | { unreadable: string }> {
  const introspection = await introspectApp(cwd, { fresh: true, graph: true, timeoutMs: CHECK_INTROSPECT_TIMEOUT_MS, withoutEnvFiles: true })
  if (introspection.status !== 'ok') return { unreadable: `the application did not introspect (${introspection.reason}): ${introspection.message.split('\n')[0]!.replaceAll(`${cwd}${sep}`, '')}` }
  const scan = await parseControllerMethods(cwd)
  const routes = manifestRouteTargets(introspection.manifest).map((route, index): RouteSecurityRecord => {
    const sources = (introspection.manifest.routes[index] as GraphRouteEntry).contractSources
    const contracts: RouteSecurityRecord['contracts'] = {}
    for (const key of CONTRACT_KEYS) {
      const schema = route.schemas[key]
      if (schema === undefined) continue
      contracts[key] = { schema, exports: (sources?.[key] ?? []).map((source) => `${source.file}#${source.exportName}`).sort() }
    }
    return {
      method: route.method,
      path: route.path,
      ...(route.name ? { name: route.name } : {}),
      module: route.module,
      ...(route.controller ? { action: `${route.controller.name}.${route.controller.action}` } : {}),
      middleware: route.middleware.map((entry) => ({
        kind: entry.kind,
        name: entry.name,
        capabilities: entry.capabilities,
        ...(entry.ability !== undefined ? { ability: entry.ability } : {}),
        ...(entry.unresolved ? { unresolved: true as const } : {}),
      })),
      contracts,
      handler: actionRecord(route.controller ? controllerMethodFor(scan, route.controller) : undefined),
    }
  })
  return { recordVersion: SECURITY_RECORD_VERSION, routes }
}

function actionRecord(lookup: ReturnType<typeof controllerMethodFor> | undefined): ActionRecord {
  if (!lookup) return { unread: 'an inline handler, whose body the reader does not follow' }
  if (!lookup.info) return { unread: `the body of ${lookup.className}'s action was not found${lookup.by === 'elsewhere' ? ' in a controller file' : ''}` }
  const { body, rawBody } = lookup.info
  const authorizes = literalAuthorizationCalls(body, rawBody)
  const validates = [...body.matchAll(VALIDATE_CALL_PATTERN)].map((match) => match[1]!.replace(/\s+/g, ''))
  return {
    authenticates: AUTH_CALL_PATTERN.test(body),
    authorizes,
    ...([...body.matchAll(AUTHORIZATION_CALLS)].length > authorizes.length ? { dynamicAuthorization: true as const } : {}),
    validates,
    ...([...body.matchAll(VALIDATE_MEMBER_CALL_PATTERN)].length > validates.length ? { dynamicValidation: true as const } : {}),
  }
}
