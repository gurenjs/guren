import { access, readFile, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { kebabCase, writeFilesSafe, type WriterOptions } from './utils'

export type DeployTarget = 'docker' | 'fly' | 'railway' | 'vercel' | 'all'

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
    await access(packagePath)
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as { name?: string }
    if (packageJson.name?.trim()) {
      return sanitizeFlyAppName(packageJson.name)
    }
  } catch {
    // Fallback to directory name when package.json is missing or invalid.
  }

  return sanitizeFlyAppName(basename(process.cwd()))
}

function dockerfileTemplate(port: number): string {
  return `# Build stage — includes devDependencies for Vite/TypeScript
FROM oven/bun:1 AS builder
WORKDIR /app

COPY bun.lock package.json ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

# Production stage — runtime only
FROM oven/bun:1-slim
WORKDIR /app

COPY --from=builder /app/package.json /app/bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --from=builder /app/bin ./bin
COPY --from=builder /app/src ./src
COPY --from=builder /app/app ./app
COPY --from=builder /app/config ./config
COPY --from=builder /app/routes ./routes
COPY --from=builder /app/public ./public
COPY --from=builder /app/db ./db
COPY --from=builder /app/.guren ./.guren

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

function vercelJsonTemplate(): string {
  return `${JSON.stringify({
    $schema: 'https://openapi.vercel.sh/vercel.json',
    installCommand: 'bun install',
    buildCommand: 'NODE_ENV=production bun run build',
    devCommand: 'bun run dev',
    routes: [
      { src: '/(.*)', dest: '/bin/serve.ts' },
    ],
  }, null, 2)}
`
}

type DeployFile = { path: string; contents: string }

function filesForTarget(target: DeployTarget, appName: string, port: number): DeployFile[] {
  const dockerFile: DeployFile = { path: 'Dockerfile', contents: dockerfileTemplate(port) }
  const flyFile: DeployFile = { path: 'fly.toml', contents: flyTomlTemplate(appName, port) }
  const railwayFile: DeployFile = { path: 'railway.json', contents: railwayJsonTemplate() }
  const vercelFile: DeployFile = { path: 'vercel.json', contents: vercelJsonTemplate() }

  switch (target) {
    case 'docker':
      return [dockerFile]
    case 'fly':
      return [dockerFile, flyFile]
    case 'railway':
      return [dockerFile, railwayFile]
    case 'vercel':
      return [vercelFile]
    case 'all':
      return [dockerFile, flyFile, railwayFile, vercelFile]
    default: {
      const exhaustive: never = target
      throw new Error(`Unsupported deploy target: ${exhaustive}`)
    }
  }
}

export async function scaffoldDeploy(options: DeployOptions = {}): Promise<string[]> {
  const target = options.target ?? 'docker'
  const port = normalizePort(options.port)
  const appName = sanitizeFlyAppName(options.appName ?? await inferAppName())
  const files = filesForTarget(target, appName, port)
  return writeFilesSafe(files, { force: Boolean(options.force) })
}
