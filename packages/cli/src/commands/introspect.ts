import type { AppManifest, DriverMapEntry, RouteEntry } from '@guren/server'
import { consola } from 'consola'

import { CliError } from '../cli-error'
import { defineCommand } from '../define-command'
import { introspectApp } from '../introspect'

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => row[column]?.length ?? 0)))
  const line = (cells: string[]): string => cells.map((cell, column) => cell.padEnd(widths[column]!)).join('  ').trimEnd()
  return [line(headers), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)].join('\n')
}

function controllerOf(route: RouteEntry): string {
  const ref = route.controller
  if (!ref) return route.prototype ? '(prototype)' : '(closure)'
  return `${ref.name}.${ref.action}${ref.file ? ` (${ref.file})` : ''}`
}

function middlewareOf(route: RouteEntry): string {
  return route.middleware.map((entry) => entry.name ?? `(${entry.kind})`).join(', ')
}

function driverMap(label: string, entry: DriverMapEntry | undefined): string[] {
  if (!entry) return []
  const entries = Object.entries(entry.entries).map(([name, { driver }]) => `${name}${driver ? `=${driver}` : ''}`)
  return [`${label}: default ${entry.default}; ${entries.join(', ')}`]
}

/** The sections as text tables; `--json` prints the manifest itself. */
export function renderManifest(manifest: AppManifest): string {
  const services = [
    ...(manifest.session
      ? [`session: ${manifest.session.source}, default ${manifest.session.default}; ${Object.entries(manifest.session.stores).map(([name, store]) => `${name}=${store.driver ?? '?'}`).join(', ')}`]
      : []),
    ...(manifest.auth
      ? [`auth: guards ${manifest.auth.guards.join(', ') || '(none)'}, default ${manifest.auth.defaultGuard ?? '(none)'}, hasher ${manifest.auth.hasher}`]
      : []),
    ...driverMap('cache', manifest.cache),
    ...driverMap('storage', manifest.storage),
    ...driverMap('queue', manifest.queue),
    ...(manifest.attachments ? [`attachments: disk ${manifest.attachments.disk ?? '?'}${manifest.attachments.delivery ? `, delivery ${manifest.attachments.delivery.mounted ? 'mounted' : 'NOT mounted'}` : ''}`] : []),
  ]

  return [
    `Entry: ${manifest.entry.file ?? '(in process)'} (${manifest.entry.root})`,
    '',
    'Providers',
    table(['Name', 'Source', 'Register', 'Error'], manifest.providers.map((provider) => [
      provider.name,
      provider.module ? `module:${provider.module}` : provider.source,
      provider.deferred ? `${provider.register} (deferred)` : provider.register,
      provider.error ?? '',
    ])),
    '',
    'Routes',
    table(['Method', 'Path', 'Name', 'Controller', 'Middleware'], manifest.routes.map((route) => [
      route.method,
      route.path,
      route.name ?? '',
      controllerOf(route),
      middlewareOf(route),
    ])),
    '',
    'Services',
    ...(services.length > 0 ? services : ['(none bound)']),
    '',
    `Agent tools: ${manifest.agentTools.length}`,
    ...(manifest.warnings.length > 0
      ? ['', 'Warnings', ...manifest.warnings.map((warning) => `  [${warning.code}] ${warning.message}`)]
      : []),
  ].join('\n')
}

export const introspectCommand = defineCommand({
  meta: {
    name: 'introspect',
    description: 'Register providers and mount routes without booting or listening, and print the app manifest (RFC 0026).',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Print the manifest as JSON.',
    },
    timeout: {
      type: 'string',
      description: 'Seconds the app may take to register before the run is abandoned. Defaults to 30.',
    },
    app: {
      type: 'string',
      description: 'Application root directory. Defaults to the current directory.',
    },
  },
  async run({ args }) {
    const seconds = args.timeout === undefined ? undefined : Number(args.timeout)
    if (seconds !== undefined && !(Number.isFinite(seconds) && seconds > 0)) {
      throw new CliError(`--timeout takes a positive number of seconds, not "${args.timeout}"`)
    }

    const result = await introspectApp(args.app ?? process.cwd(), {
      timeoutMs: seconds === undefined ? undefined : seconds * 1000,
    })

    if (result.status === 'failed') {
      process.exitCode = 1
      if (args.json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        consola.error(`Introspection failed (${result.reason}): ${result.message}`)
      }
      return
    }

    console.log(args.json ? JSON.stringify(result.manifest, null, 2) : renderManifest(result.manifest))
  },
})
