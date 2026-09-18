/**
 * The local tools of in-process agents (RFC 0029 §2.4): every `tools()` entry
 * that is not an `appTools()` spread runs with its closure's authority, outside
 * the scope, policy, approval and audit gates. `guren audit` lists them all; the
 * one advisory is an `execute` body writing through a Model whose table an
 * `.agent()` route's action also touches, which a gated route could do instead.
 * The listing is the point: a tool calling a service or the network is caught
 * by the reviewer reading it, not by this scan.
 */
import { resolve } from 'node:path'
import { deriveAgentTools, type RouteDefinition } from '@guren/core'
import { scanAiAgents } from './ai-agent-scan'
import { LOCAL_TOOL_WRITE_PATTERN, type ControllerMethodInfo } from './controller-methods'
import { discoverModelFiles } from './discovery'
import { extractClassDeclaration, extractTableIdentifier } from './model-parser'
import { ParseCache } from './parse-cache'
import { escapeRegExp } from './utils'
import type { AuditFinding } from './audit'

export interface AiLocalToolListing {
  agent: string
  tool: string
  filePath: string
  line: number
  /** Whether the `execute` body was located and read. */
  executeRead: boolean
  /** Whether that body calls a Model write. */
  writes: boolean
}

/** Model class name → the schema table identifier it binds (the class name when unreadable). */
async function modelTables(cwd: string, cache: ParseCache): Promise<Map<string, string>> {
  const tables = new Map<string, string>()
  for (const filePath of await discoverModelFiles(cwd)) {
    const parsed = await cache.get(filePath)
    for (const statement of parsed?.ast.program.body ?? []) {
      const classDecl = extractClassDeclaration(statement)
      if (!classDecl?.id) continue
      tables.set(classDecl.id.name, extractTableIdentifier(classDecl) ?? classDecl.id.name)
    }
  }
  return tables
}

function tablesReferenced(body: string, tables: ReadonlyMap<string, string>): Set<string> {
  const referenced = new Set<string>()
  for (const [model, table] of tables) {
    if (new RegExp(`\\b${escapeRegExp(model)}\\s*\\.`).test(body)) referenced.add(table)
  }
  return referenced
}

export async function auditAiLocalTools(
  cwd: string,
  definitions: RouteDefinition[] | undefined,
  controllerMethods: ReadonlyMap<string, ControllerMethodInfo>,
  findings: AuditFinding[],
): Promise<AiLocalToolListing[] | undefined> {
  const cache = new ParseCache()
  const agents = await scanAiAgents(cwd, cache)
  if (agents.length === 0) return undefined

  // Each finding carries a line, which `config/audit.ts` refuses, so the inline comment is its one suppression.
  const suppressed = async (relPath: string, line: number): Promise<boolean> => {
    const lines = (await cache.source(resolve(cwd, relPath)))?.split('\n') ?? []
    return [lines[line - 1], lines[line - 2]].some((text) => text?.includes('guren-audit-ignore'))
  }
  const listings: AiLocalToolListing[] = []
  const writing: Array<{ listing: AiLocalToolListing; body: string }> = []

  for (const agent of agents) {
    if (agent.localToolsUnreadable && !(await suppressed(agent.relPath, agent.line))) {
      findings.push({
        key: `ai-local-tools-unreadable:${agent.className}`,
        title: `${agent.className} local tools`,
        status: 'warn',
        message: `${agent.className}'s local tools could not all be listed: ${agent.localToolsUnreadable}. A tool outside appTools() runs with no scope, policy, approval or audit.`,
        suggestion: 'Return an object literal from tools(), with appTools() spread into it, so every local tool is listed.',
        filePath: agent.relPath,
        line: agent.line,
      })
    }
    for (const tool of agent.localTools) {
      const writes = tool.executeBody !== undefined && LOCAL_TOOL_WRITE_PATTERN.test(tool.executeBody)
      const listing: AiLocalToolListing = {
        agent: agent.className,
        tool: tool.name,
        filePath: agent.relPath,
        line: tool.line,
        executeRead: tool.executeBody !== undefined,
        writes,
      }
      listings.push(listing)
      if (writes) writing.push({ listing, body: tool.executeBody! })
    }
  }

  if (writing.length === 0) return listings

  const tables = await modelTables(cwd, cache)
  const routeTables = new Map<string, string[]>()
  for (const tool of deriveAgentTools(definitions ?? []).tools) {
    const route = definitions!.find((candidate) =>
      candidate.name === tool.routeName && candidate.method.toUpperCase() === tool.method && candidate.path === tool.path)
    const method = route?.controller && controllerMethods.get(`${route.controller.name}.${route.controller.action}`)
    if (!method) continue
    for (const table of tablesReferenced(method.body, tables)) {
      routeTables.set(table, [...(routeTables.get(table) ?? []), tool.toolName])
    }
  }

  for (const { listing, body } of writing) {
    const covering = [...tablesReferenced(body, tables)].flatMap((table) => routeTables.get(table) ?? [])
    if (covering.length === 0 || (await suppressed(listing.filePath, listing.line))) continue
    const tools = [...new Set(covering)].sort()
    findings.push({
      key: `ai-local-tool-write:${listing.agent}.${listing.tool}`,
      title: `${listing.agent}.${listing.tool} local tool`,
      status: 'warn',
      message: `The local tool '${listing.tool}' writes through a Model whose table the agent tool(s) ${tools.join(', ')} also act on. The route runs the scope, policy, approval and audit gates; this tool runs none of them.`,
      suggestion: `Hand the agent the route instead: this.appTools([${tools.map((name) => `'${name}'`).join(', ')}]), granted in static scopes.`,
      filePath: listing.filePath,
      line: listing.line,
    })
  }

  return listings
}

export function describeLocalTool(listing: AiLocalToolListing): string {
  const notes: string[] = []
  if (listing.writes) notes.push('writes records')
  if (!listing.executeRead) notes.push('execute not read')
  const where = `${listing.filePath}:${listing.line}`
  return `${listing.agent}.${listing.tool} (${where})${notes.length > 0 ? `: ${notes.join(', ')}` : ''}`
}
