import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The minimum app on disk `buildCloudflareOutput` will assemble a worker from:
 * an entry module, a manifest, a client bundle, and optionally an SSR build.
 *
 * One definition, shared by `build.test.ts` and `mcp-oauth.test.ts`. Two
 * copies is how the second suite comes to test a fixture the first stopped
 * writing — and every assertion here is about the *generated* output, so the
 * input has to be the same input.
 */

export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2))
}

/** The client manifest {@link scaffoldApp} writes — assertions derive from this. */
export const CLIENT_MANIFEST = {
  'resources/js/app.tsx': { file: 'app-Abc123.js', css: ['app-Def456.css'] },
}

export interface ScaffoldAppOptions {
  ssr?: boolean
  renderExport?: string
  /**
   * Declare `@guren/plugin-mcp` under `dependencies` — the App MCP opt-in the
   * build reads (RFC 0016 §7).
   */
  mcpPlugin?: boolean
  /** Declare `@cloudflare/workers-oauth-provider` under `dependencies`. */
  oauthProvider?: boolean
  /**
   * Declare the OAuth provider under `devDependencies` instead. A production
   * install has none, so this must not satisfy the guard.
   */
  oauthProviderAsDevDependency?: boolean
}

export function scaffoldApp(root: string, options: ScaffoldAppOptions = {}): void {
  const {
    ssr = true,
    renderExport = 'export const render = () => ({ body: "", head: [] })',
    mcpPlugin = false,
    oauthProvider = false,
    oauthProviderAsDevDependency = false,
  } = options

  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src/app.ts'), 'export default { boot: async () => {}, fetch: async () => new Response("ok") }\n')

  const dependencies: Record<string, string> = {}
  if (mcpPlugin) dependencies['@guren/plugin-mcp'] = '^0.2.0'
  if (oauthProvider) dependencies['@cloudflare/workers-oauth-provider'] = '^0.10.3'

  writeJson(join(root, 'package.json'), {
    name: '@acme/demo-app',
    ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
    ...(oauthProviderAsDevDependency
      ? { devDependencies: { '@cloudflare/workers-oauth-provider': '^0.10.3' } }
      : {}),
  })

  mkdirSync(join(root, 'public/assets/.vite'), { recursive: true })
  writeFileSync(join(root, 'public/robots.txt'), 'User-agent: *\n')
  writeFileSync(join(root, 'public/assets/app-Abc123.js'), 'console.log("client")\n')
  writeJson(join(root, 'public/assets/.vite/manifest.json'), CLIENT_MANIFEST)

  if (ssr) {
    mkdirSync(join(root, '.guren/ssr/.vite'), { recursive: true })
    writeFileSync(join(root, '.guren/ssr/ssr-Xyz789.js'), `${renderExport}\n`)
    writeJson(join(root, '.guren/ssr/.vite/manifest.json'), {
      'resources/js/ssr.tsx': { file: 'ssr-Xyz789.js' },
    })
  }
}

/** Collect everything a run wrote to `console.warn`, joined by newline. */
export async function captureWarnings(run: () => Promise<void>): Promise<string> {
  const warnings: string[] = []
  const original = console.warn
  console.warn = (message: string) => warnings.push(message)
  try {
    await run()
  } finally {
    console.warn = original
  }
  return warnings.join('\n')
}

/** Collect everything a run wrote to `console.log`, joined by newline. */
export async function captureLogs(run: () => Promise<void>): Promise<string> {
  const logs: string[] = []
  const original = console.log
  console.log = (message: string) => logs.push(message)
  try {
    await run()
  } finally {
    console.log = original
  }
  return logs.join('\n')
}
