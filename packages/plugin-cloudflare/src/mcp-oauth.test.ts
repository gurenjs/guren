import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildCloudflareOutput } from './build'
import {
  MCP_OAUTH_CONSENT_VIEW_FILE,
  MCP_OAUTH_CONTROLLER_FILE,
  MCP_OAUTH_REGISTRAR,
  MCP_OAUTH_ROUTES_FILE,
  MCP_OAUTH_TEMPLATE_FILES,
  loadMcpOAuthTemplate,
} from './templates'
import { captureLogs, captureWarnings, scaffoldApp, writeJson } from '../tests/app-fixture'

/** The one config shape a `--mcp-oauth` build accepts on an existing file. */
function oauthReadyConfig(): Record<string, unknown> {
  return {
    name: 'demo-app',
    main: '.cloudflare/worker.js',
    kv_namespaces: [{ binding: 'OAUTH_KV', id: 'abc123' }],
  }
}

describe('cloudflare:build --mcp-oauth', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'guren-cf-oauth-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  describe('guards', () => {
    test('should refuse the flag on an app that does not depend on @guren/plugin-mcp', async () => {
      scaffoldApp(root, { oauthProvider: true })

      await expect(
        buildCloudflareOutput({ rootDir: root, skipAppBuild: true, mcpOAuth: true }),
      ).rejects.toThrow(/@guren\/plugin-mcp/)
    })

    test('should refuse the flag when the provider package is not a dependency', async () => {
      scaffoldApp(root, { mcpPlugin: true })

      await expect(
        buildCloudflareOutput({ rootDir: root, skipAppBuild: true, mcpOAuth: true }),
      ).rejects.toThrow(/bun add @cloudflare\/workers-oauth-provider/)
    })

    /**
     * `wrangler deploy` resolves the generated worker's imports from the deploy
     * environment's install, which carries no devDependencies — so a devDependency
     * passes a local build and fails the deploy.
     */
    test('should refuse the flag when the provider package is only a devDependency', async () => {
      scaffoldApp(root, { mcpPlugin: true, oauthProviderAsDevDependency: true })

      await expect(
        buildCloudflareOutput({ rootDir: root, skipAppBuild: true, mcpOAuth: true }),
      ).rejects.toThrow(/bun add @cloudflare\/workers-oauth-provider/)
    })

    test('should refuse when the committed config binds no OAUTH_KV, naming the exact entry', async () => {
      scaffoldApp(root, { mcpPlugin: true, oauthProvider: true })
      writeJson(join(root, 'wrangler.jsonc'), { name: 'demo-app', main: '.cloudflare/worker.js' })

      const failure = await buildCloudflareOutput({
        rootDir: root,
        skipAppBuild: true,
        mcpOAuth: true,
      }).catch((error: Error) => error.message)

      expect(failure).toContain('"kv_namespaces"')
      expect(failure).toContain('"binding": "OAUTH_KV"')
      expect(failure).toContain('wrangler kv namespace create OAUTH_KV')
    })

    test('should accept a config whose OAUTH_KV binding is already there', async () => {
      scaffoldApp(root, { mcpPlugin: true, oauthProvider: true })
      writeJson(join(root, 'wrangler.jsonc'), oauthReadyConfig())

      await captureWarnings(() =>
        buildCloudflareOutput({ rootDir: root, skipAppBuild: true, mcpOAuth: true }),
      )

      expect(existsSync(join(root, '.cloudflare/worker.js'))).toBe(true)
    })

    /**
     * The binding is present but its id is still the scaffolded placeholder, which
     * `wrangler deploy` rejects. Warned rather than failed: the id is not needed to
     * *build*, and a --dry-run deploy on an unfinished config is reasonable.
     */
    test('should warn when the OAUTH_KV binding still has the scaffolded placeholder id', async () => {
      scaffoldApp(root, { mcpPlugin: true, oauthProvider: true })
      writeJson(join(root, 'wrangler.jsonc'), {
        name: 'demo-app',
        kv_namespaces: [{ binding: 'OAUTH_KV', id: 'TODO: wrangler kv namespace create OAUTH_KV' }],
      })

      const warning = await captureWarnings(() =>
        buildCloudflareOutput({ rootDir: root, skipAppBuild: true, mcpOAuth: true }),
      )

      expect(warning).toContain('placeholder id')
      expect(warning).toContain('wrangler kv namespace create OAUTH_KV')
      // Warned, not failed.
      expect(existsSync(join(root, '.cloudflare/worker.js'))).toBe(true)
    })

    test('should not warn when the OAUTH_KV binding carries a real id', async () => {
      scaffoldApp(root, { mcpPlugin: true, oauthProvider: true })
      writeJson(join(root, 'wrangler.jsonc'), oauthReadyConfig())

      const warning = await captureWarnings(() =>
        buildCloudflareOutput({ rootDir: root, skipAppBuild: true, mcpOAuth: true }),
      )

      expect(warning).not.toContain('placeholder id')
    })

    /**
     * A `kv_namespaces` array holding some *other* binding is not the provider's
     * namespace: "has kv_namespaces" is the cheap wrong test, and it passes an app
     * one line short of working.
     */
    test('should refuse a config whose kv_namespaces bind something else', async () => {
      scaffoldApp(root, { mcpPlugin: true, oauthProvider: true })
      writeJson(join(root, 'wrangler.jsonc'), {
        name: 'demo-app',
        kv_namespaces: [{ binding: 'SESSIONS', id: 'xyz' }],
      })

      await expect(
        buildCloudflareOutput({ rootDir: root, skipAppBuild: true, mcpOAuth: true }),
      ).rejects.toThrow(/OAUTH_KV/)
    })

    test('should not require OAUTH_KV when the flag is off', async () => {
      scaffoldApp(root, { mcpPlugin: true })
      writeJson(join(root, 'wrangler.jsonc'), { name: 'demo-app', main: '.cloudflare/worker.js' })

      await captureWarnings(() => buildCloudflareOutput({ rootDir: root, skipAppBuild: true }))

      expect(existsSync(join(root, '.cloudflare/worker.js'))).toBe(true)
    })

    /**
     * The guards run before the app build, so a misconfigured app is told in one
     * second rather than after minutes of Vite output. Asserted by giving the app
     * a `build` script that would fail if it ever ran.
     */
    test('should refuse before running the app build', async () => {
      scaffoldApp(root, { mcpPlugin: true })
      writeJson(join(root, 'package.json'), {
        name: 'demo-app',
        dependencies: { '@guren/plugin-mcp': '^0.2.0' },
        scripts: { build: 'exit 1' },
      })

      await expect(
        buildCloudflareOutput({ rootDir: root, mcpOAuth: true }),
      ).rejects.toThrow(/workers-oauth-provider/)
    })
  })

  describe('generated worker', () => {
    beforeEach(() => {
      scaffoldApp(root, { mcpPlugin: true, oauthProvider: true })
    })

    async function build(options: { mcpPath?: string } = {}): Promise<string> {
      await buildCloudflareOutput({
        rootDir: root,
        skipAppBuild: true,
        mcpOAuth: true,
        ...options,
      })
      return readFileSync(join(root, '.cloudflare/worker.js'), 'utf8')
    }

    test('should export an OAuthProvider wrapping the app', async () => {
      const worker = await build()

      expect(worker).toContain("import { OAuthProvider } from \"@cloudflare/workers-oauth-provider\"")
      expect(worker).toContain('export default new OAuthProvider({')
      expect(worker).toContain('apiRoute: "/mcp"')
      expect(worker).toContain('defaultHandler: handler')
      expect(worker).toContain('authorizeEndpoint: "/oauth/authorize"')
      expect(worker).toContain('tokenEndpoint: "/oauth/token"')
      expect(worker).toContain('clientRegistrationEndpoint: "/oauth/register"')
      // No bare `export default createWorkersHandler(app)` — that would serve
      // the MCP endpoint outside the provider entirely.
      expect(worker).not.toContain('export default createWorkersHandler(app)')
    })

    test('should import the seam from the plugin-mcp oauth subpath', async () => {
      const worker = await build()

      expect(worker).toContain(
        'import { mcpOAuthPropsToAuth, presentExternalMcpAuth } from "@guren/plugin-mcp/oauth"',
      )
      expect(worker).toContain('mcpOAuthPropsToAuth(ctx.props)')
      expect(worker).toContain('presentExternalMcpAuth(request, auth)')
    })

    /**
     * The handoff must be the request the seam registered against: dispatching a
     * rebuilt or original request loses the identity the map is keyed on, and
     * every call 401s.
     */
    test('should dispatch the presented request itself, not a copy', async () => {
      const worker = await build()

      expect(worker).toContain('handler.fetch(presentExternalMcpAuth(request, auth), env, ctx)')
      expect(worker).not.toMatch(/handler\.fetch\(request,/)
      expect(worker).not.toContain('new Request(request')
    })

    test('should refuse a grant whose props do not map, with 401', async () => {
      const worker = await build()

      expect(worker).toContain('if (!auth) {')
      expect(worker).toContain('status: 401')
    })

    /**
     * One `createWorkersHandler`, threaded through both halves: two would each
     * dedupe boot in their own slot while sharing the module-global env holder,
     * the topology `handler.ts` says it cannot reason about.
     */
    test('should construct exactly one handler and share it', async () => {
      const worker = await build()

      expect(worker.match(/createWorkersHandler\(app\)/g)).toHaveLength(1)
      expect(worker).toContain('const handler = createWorkersHandler(app)')
    })

    test('should protect a custom mcp path when one is given', async () => {
      const worker = await build({ mcpPath: '/agent/mcp' })

      expect(worker).toContain('apiRoute: "/agent/mcp"')
    })

    test('should still wire SSR and the env module', async () => {
      const worker = await build()

      expect(worker.startsWith('// Generated by `guren cloudflare:build`')).toBe(true)
      expect(worker).toContain("import './worker-env.js'")
      expect(worker).toContain('setInertiaSsrRenderer(ssrModule.render)')
    })

    test('should be valid JavaScript', async () => {
      // A generated module nothing parses is a deploy-time syntax error.
      const worker = await build()
      expect(() => new Bun.Transpiler({ loader: 'js' }).transformSync(worker)).not.toThrow()
    })
  })

  describe('worker without the flag', () => {
    test('should carry no OAuth wiring at all', async () => {
      scaffoldApp(root, { mcpPlugin: true, oauthProvider: true })

      await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })

      const worker = readFileSync(join(root, '.cloudflare/worker.js'), 'utf8')
      expect(worker).toContain('export default createWorkersHandler(app)')
      expect(worker).not.toContain('OAuthProvider')
      expect(worker).not.toContain('@guren/plugin-mcp/oauth')
    })

    test('should warn when the committed config still binds OAUTH_KV', async () => {
      scaffoldApp(root, { mcpPlugin: true, oauthProvider: true })
      writeJson(join(root, 'wrangler.jsonc'), oauthReadyConfig())

      const warning = await captureWarnings(() =>
        buildCloudflareOutput({ rootDir: root, skipAppBuild: true }),
      )

      expect(warning).toContain('--mcp-oauth')
      expect(warning).toContain('OAUTH_KV')
    })

    test('should not warn about OAuth when the config binds no OAUTH_KV', async () => {
      scaffoldApp(root, { mcpPlugin: true })
      writeJson(join(root, 'wrangler.jsonc'), { name: 'demo-app', kv_namespaces: [] })

      const warning = await captureWarnings(() =>
        buildCloudflareOutput({ rootDir: root, skipAppBuild: true }),
      )

      expect(warning).not.toContain('--mcp-oauth')
    })

    test('should scaffold no consent flow', async () => {
      scaffoldApp(root, { mcpPlugin: true, oauthProvider: true })

      await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })

      expect(existsSync(join(root, MCP_OAUTH_ROUTES_FILE))).toBe(false)
    })
  })

  describe('wrangler.jsonc scaffold', () => {
    test('should write the OAUTH_KV binding into a fresh config', async () => {
      scaffoldApp(root, { mcpPlugin: true, oauthProvider: true })

      await captureLogs(() =>
        buildCloudflareOutput({ rootDir: root, skipAppBuild: true, mcpOAuth: true }),
      )

      const config = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'))
      expect(config.kv_namespaces).toEqual([
        { binding: 'OAUTH_KV', id: 'TODO: wrangler kv namespace create OAUTH_KV' },
      ])
    })

    test('should say the namespace still has to be created', async () => {
      scaffoldApp(root, { mcpPlugin: true, oauthProvider: true })

      const logs = await captureLogs(() =>
        buildCloudflareOutput({ rootDir: root, skipAppBuild: true, mcpOAuth: true }),
      )

      expect(logs).toContain('wrangler kv namespace create OAUTH_KV')
    })

    test('should write no OAUTH_KV binding without the flag', async () => {
      scaffoldApp(root, { mcpPlugin: true })

      await captureLogs(() => buildCloudflareOutput({ rootDir: root, skipAppBuild: true }))

      const config = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'))
      expect(config.kv_namespaces).toBeUndefined()
    })
  })

  describe('consent flow scaffold', () => {
    beforeEach(() => {
      scaffoldApp(root, { mcpPlugin: true, oauthProvider: true })
    })

    test('should write every template file at its template path', async () => {
      await captureLogs(() =>
        buildCloudflareOutput({ rootDir: root, skipAppBuild: true, mcpOAuth: true }),
      )

      for (const path of MCP_OAUTH_TEMPLATE_FILES) {
        expect(readFileSync(join(root, path), 'utf8')).toBe(loadMcpOAuthTemplate(path))
      }
    })

    test('should print the two lines that wire the routes file in', async () => {
      const logs = await captureLogs(() =>
        buildCloudflareOutput({ rootDir: root, skipAppBuild: true, mcpOAuth: true }),
      )

      expect(logs).toContain(`import { ${MCP_OAUTH_REGISTRAR} } from './mcp-oauth'`)
      expect(logs).toContain(`${MCP_OAUTH_REGISTRAR}(router)`)
    })

    test('should never overwrite a file the developer already has', async () => {
      const target = join(root, MCP_OAUTH_ROUTES_FILE)
      await captureLogs(() =>
        buildCloudflareOutput({ rootDir: root, skipAppBuild: true, mcpOAuth: true }),
      )
      writeFileSync(target, '// mine now\n')

      await captureLogs(() =>
        buildCloudflareOutput({ rootDir: root, skipAppBuild: true, mcpOAuth: true }),
      )

      expect(readFileSync(target, 'utf8')).toBe('// mine now\n')
    })

    test('should stop repeating the wiring instruction once the file exists', async () => {
      await captureLogs(() =>
        buildCloudflareOutput({ rootDir: root, skipAppBuild: true, mcpOAuth: true }),
      )

      const second = await captureLogs(() =>
        buildCloudflareOutput({ rootDir: root, skipAppBuild: true, mcpOAuth: true }),
      )

      expect(second).not.toContain(MCP_OAUTH_REGISTRAR)
    })
  })
})

/**
 * The template tree's own gate. These files ship as real sources compiled by the
 * root `tsconfig` program, so what is left is the shape the scaffold and
 * `guren check` depend on, which no compiler asserts.
 */
/** The template files that are TSX, derived rather than restated. */
const TSX_TEMPLATE_FILES = MCP_OAUTH_TEMPLATE_FILES.filter((path) => path.endsWith('.tsx'))

/**
 * Parse a template, picking the loader from its extension. `.tsx` needs
 * `loader: 'tsx'`: under `'ts'` the transpiler reads `<div>` as a type assertion
 * and throws.
 */
function transpile(source: string, path: string): string {
  return new Bun.Transpiler({ loader: path.endsWith('.tsx') ? 'tsx' : 'ts' }).transformSync(source)
}

describe('mcp-oauth templates', () => {
  /**
   * A template's code with its comments gone, for the assertions that say a
   * construct is *absent*: these files document what they deliberately do not do,
   * so a raw substring search would find the prose and report it as the thing.
   */
  function code(path: string): string {
    return transpile(loadMcpOAuthTemplate(path), path)
  }

  const routes = loadMcpOAuthTemplate(MCP_OAUTH_ROUTES_FILE)
  const controller = loadMcpOAuthTemplate(MCP_OAUTH_CONTROLLER_FILE)
  const controllerCode = code(MCP_OAUTH_CONTROLLER_FILE)
  const consentView = loadMcpOAuthTemplate(MCP_OAUTH_CONSENT_VIEW_FILE)

  test.each([...MCP_OAUTH_TEMPLATE_FILES])('should parse as TypeScript: %s', (path: string) => {
    const source = loadMcpOAuthTemplate(path)
    expect(() => transpile(source, path)).not.toThrow()
  })

  /**
   * The pragma overrides `jsxImportSource` for that module alone, so a `.tsx`
   * template compiles in an app pointing `jsx: "react-jsx"` at React without a
   * tsconfig change. It is only honoured on the **first** line, hence the position check.
   */
  test.each(TSX_TEMPLATE_FILES)('should open with the guren jsxImportSource pragma: %s', (path: string) => {
    expect(loadMcpOAuthTemplate(path).split('\n')[0]).toBe('/** @jsxImportSource @guren/core */')
  })

  /**
   * A view reaching for the plugin root, a node builtin or a client-side React
   * import would be a scaffolded file an app cannot compile. `@guren/core` carries
   * everything these components use: `FC`, `DerivedAgentTool`, `CSRF_FORM_FIELD`.
   */
  test.each(TSX_TEMPLATE_FILES)('should import from @guren/core alone: %s', (path: string) => {
    const specifiers = [...loadMcpOAuthTemplate(path).matchAll(/from '([^']+)'/g)].map((m) => m[1])

    expect(specifiers.length).toBeGreaterThan(0)
    expect([...new Set(specifiers)]).toEqual(['@guren/core'])
  })

  test('should export a registrar under the name the scaffold instruction prints', () => {
    expect(routes).toContain(`export function ${MCP_OAUTH_REGISTRAR}(`)
  })

  /**
   * `@guren/core`'s route loader accepts a registrar named `default` or matching
   * `/^register\w*Routes$/`. A template whose export fell outside that pattern
   * would scaffold a file the framework never calls, while looking wired.
   */
  test('should name its registrar inside the pattern the route loader accepts', () => {
    expect(MCP_OAUTH_REGISTRAR).toMatch(/^register\w*Routes$/u)
  })

  /**
   * These routes are the gate an agent passes through, not a tool it may call:
   * consent is never something a client grants itself.
   */
  test('should expose no route to agents', () => {
    expect(code(MCP_OAUTH_ROUTES_FILE)).not.toContain('.agent(')
  })

  test('should reach the controller by the path the scaffold writes it to', () => {
    // A template's path under templates/mcp-oauth/ is the path it lands on in the
    // app, so this relative import resolves in both. Both paths are spelled out
    // because the constant is one of the two things being checked to agree.
    expect(routes).toContain("from '../app/Http/Controllers/McpOAuthController.js'")
    expect(MCP_OAUTH_TEMPLATE_FILES).toContain('app/Http/Controllers/McpOAuthController.ts')
  })

  /**
   * The wire form the endpoint's scope grammar parses: `parseToolScope` silently
   * ignores every entry outside `tool:` / `tools:`, so a checkbox valued with the
   * bare tool name would say "granted" and grant nothing.
   */
  test('should submit granted scopes in the tool: wire form', () => {
    // Both halves live in different files: the view renders the checkbox value,
    // the controller rebuilds the same string to intersect against.
    expect(consentView).toContain('value={`tool:${tool.toolName}`}')
    expect(controller).toContain('`tool:${tool.toolName}`')
  })

  test('should derive the offered tools live rather than from a manifest', () => {
    expect(controller).toContain('deriveAgentTools(')
    expect(controllerCode).not.toContain('agents.gen')
  })

  test('should intersect the submission with what the client requested', () => {
    expect(controller).toContain('expandToolScopes(')
    expect(controller).toContain('offeredScopes.has(scope)')
  })

  test('should carry the CSRF field into the consent form', () => {
    // The view renders the token as a plain JSX input, not a string-returning
    // helper, which would be raw HTML where the renderer owns escaping.
    expect(controller).toContain('csrfToken: getCsrfToken(this.ctx)')
    expect(consentView).toContain('<input type="hidden" name={CSRF_FORM_FIELD} value={csrfToken} />')
  })

  /**
   * And verify it in the action, through `verifyCsrfToken` rather than a second
   * comparison of its own. The global middleware may not be mounted
   * (`autoSession: false`, a hand-composed chain) while `csrfField()` still
   * renders a convincing token, so the screen would only *look* protected.
   */
  test('should verify the CSRF token itself, via the framework primitive', () => {
    expect(controller).toContain('verifyCsrfToken(this.ctx, single(form[CSRF_FORM_FIELD]))')
    expect(controllerCode).not.toContain('_csrf_token')
  })

  test('should tick read-only tools only, leaving writes unchecked by default', () => {
    expect(consentView).toContain('checked={tool.annotations.readOnlyHint}')
  })

  /**
   * The renderer owns escaping, so a hand-rolled escaper here signals raw markup,
   * which `hono/jsx` escapes into visible angle brackets or, through
   * `dangerouslySetInnerHTML`, does not escape at all.
   */
  test('should hand-escape nothing and inject no raw HTML', () => {
    for (const path of MCP_OAUTH_TEMPLATE_FILES) {
      expect(code(path)).not.toContain('escapeHtml')
      expect(code(path)).not.toContain('dangerouslySetInnerHTML')
    }
  })

  test('should answer a malformed authorize request with a page, not a throw', () => {
    // Both actions route through the wrapper: a bare `parseAuthRequest` 500s with
    // a stack trace on a tampered query, a routine arrival at this URL.
    expect(controller).toContain('this.parseAuthRequest(provider, this.ctx.req.raw)')
    // Two call sites: show() and approve(). The declaration is
    // `private async parseAuthRequest(`, so it is not one of these.
    expect(controller.match(/this\.parseAuthRequest\(/g)).toHaveLength(2)
    // Exactly one place actually calls the provider: the wrapper's own try.
    expect(controllerCode.match(/provider\.parseAuthRequest\(/g)).toHaveLength(1)
  })

  test('should store the app-typed user id and the granted scopes in props', () => {
    expect(controller).toContain('props: { userId, scopes: granted }')
    // The provider's own identifier is a string; props keeps the app's type.
    expect(controller).toContain('userId: String(userId)')
  })
})
