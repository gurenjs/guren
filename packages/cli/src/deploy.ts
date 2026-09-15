import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { assertCwdUnsupported, kebabCase, writeScaffoldFiles, type WriterOptions } from './utils'

export type DeployTarget = 'docker' | 'fly' | 'railway' | 'all'

export interface DeployOptions extends WriterOptions {
  target?: DeployTarget
  appName?: string
  port?: number
}

function normalizePort(port?: number): number {
  if (port === undefined) {
    return 3333
  }
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('Port must be a positive integer.')
  }
  return port
}

function sanitizeFlyAppName(name: string): string {
  const normalized = kebabCase(name.replace(/\//gu, '-')).replace(/[^a-z0-9-]/gu, '').replace(/^-+|-+$/gu, '')
  return normalized.length > 0 ? normalized : 'guren-app'
}

async function inferAppName(): Promise<string> {
  const packagePath = resolve(process.cwd(), 'package.json')

  try {
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as { name?: string }
    if (packageJson.name?.trim()) {
      return sanitizeFlyAppName(packageJson.name)
    }
  } catch {
    // Fallback to directory name when package.json is missing or invalid.
  }

  return sanitizeFlyAppName(basename(process.cwd()))
}

/**
 * What `bun bin/serve.ts` reads from the app root, and so what the production
 * image copies. `tests/deploy.test.ts` fails on a create-app template entry these
 * lists omit, not on a generator's: `modules` (`make:module`) is added by hand, and
 * `storage` stays out on purpose, since uploads belong on a volume or object storage.
 */
export const DOCKER_RUNTIME_DIRECTORIES = ['bin', 'src', 'app', 'config', 'routes', 'modules', 'db', 'lang', 'public', '.guren'] as const
/** `tsconfig.json` carries the `@/` alias, which Bun resolves from it at runtime. */
export const DOCKER_RUNTIME_FILES = ['tsconfig.json'] as const

function dockerfileTemplate(port: number): string {
  const copies = [...DOCKER_RUNTIME_FILES, ...DOCKER_RUNTIME_DIRECTORIES]
    .map((entry) => `COPY --from=builder /app/${entry} ./${entry}`)
    .join('\n')

  return `# Build stage — includes devDependencies for Vite/TypeScript
FROM oven/bun:1 AS builder
WORKDIR /app

COPY bun.lock package.json ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build
# COPY fails on a missing source, and not every app has every runtime
# directory (an API-only app has no public/, lang/ or .guren/).
RUN mkdir -p ${DOCKER_RUNTIME_DIRECTORIES.join(' ')}

# Production stage — runtime only
FROM oven/bun:1-slim
WORKDIR /app

COPY --from=builder /app/package.json /app/bun.lock ./
RUN bun install --frozen-lockfile --production

${copies}

EXPOSE ${port}
ENV NODE_ENV=production
CMD ["bun", "bin/serve.ts"]
`
}

function flyTomlTemplate(appName: string, port: number): string {
  return `app = "${appName}"
primary_region = "nrt"

[build]
  dockerfile = "Dockerfile"

[env]
  NODE_ENV = "production"
  PORT = "${port}"

[http_service]
  internal_port = ${port}
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0
  processes = ["app"]

# Health check for Fly machines — expects /health to return 200
[[services]]
  internal_port = ${port}
  processes = ["app"]

  [[services.http_checks]]
    path = "/health"
    method = "GET"
    timeout = "2s"
    interval = "10s"
    grace_period = "1m"
    restart_limit = 0

# Secrets note: set secrets with \`fly secrets set NAME=value\`
# Example placeholders (uncomment and set if needed)
# [secrets]
#   DATABASE_URL = ""

[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory_mb = 512
`
}

function railwayJsonTemplate(): string {
  return `${JSON.stringify({
    $schema: 'https://railway.app/railway.schema.json',
    build: {
      builder: 'DOCKERFILE',
      dockerfilePath: 'Dockerfile',
    },
    deploy: {
      startCommand: 'bun run bin/serve.ts',
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 10,
    },
  }, null, 2)}
`
}

type DeployFile = { path: string; contents: string }

function filesForTarget(target: DeployTarget, appName: string, port: number): DeployFile[] {
  const dockerFile: DeployFile = { path: 'Dockerfile', contents: dockerfileTemplate(port) }
  const flyFile: DeployFile = { path: 'fly.toml', contents: flyTomlTemplate(appName, port) }
  const railwayFile: DeployFile = { path: 'railway.json', contents: railwayJsonTemplate() }
  switch (target) {
    case 'docker':
      return [dockerFile]
    case 'fly':
      return [dockerFile, flyFile]
    case 'railway':
      return [dockerFile, railwayFile]
    case 'all':
      return [dockerFile, flyFile, railwayFile]
    default: {
      const exhaustive: never = target
      throw new Error(`Unsupported deploy target: ${exhaustive}`)
    }
  }
}

export async function scaffoldDeploy(options: DeployOptions = {}): Promise<string[]> {
  assertCwdUnsupported(options, 'guren deploy')
  const target = options.target ?? 'docker'
  const port = normalizePort(options.port)
  const appName = sanitizeFlyAppName(options.appName ?? await inferAppName())
  const files = filesForTarget(target, appName, port)
  return writeScaffoldFiles(files, { force: Boolean(options.force), overwritten: options.overwritten })
}
