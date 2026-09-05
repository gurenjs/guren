import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCloudflareOutput } from './build'

import {
  captureWarnings,
  scaffoldApp,
  writeAgentModule,
  writeAgentsConfig,
  writeJson,
  type ScaffoldAppOptions,
} from '../tests/app-fixture'

/** An app hosting one agent, with the plugin declared and the module on disk. */
function scaffoldAgentApp(root: string, options: ScaffoldAppOptions = {}): void {
  scaffoldApp(root, { agentsPlugin: true, ...options })
  writeAgentsConfig(root, { triager: { module: 'app/Agents/Triager.ts', export: 'Triager' } })
  writeAgentModule(root, 'app/Agents/Triager.ts', 'Triager')
}

/** A committed config hosting `Triager` the way the scaffold would. */
function hostingConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'legacy',
    main: '.cloudflare/worker.js',
    durable_objects: { bindings: [{ name: 'TRIAGER', class_name: 'Triager' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Triager'] }],
    ...extra,
  }
}

describe('reading config/agents.ts', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'guren-cf-agents-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('should leave an app with no registry exactly as it was', async () => {
    scaffoldApp(root)

    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })

    // Byte-identical to a build that never learned about agents: the whole
    // feature hangs off the presence of one file.
    const worker = readFileSync(join(root, '.cloudflare/worker.js'), 'utf8')
    expect(worker).toContain('export default createWorkersHandler(app)')
    expect(worker).not.toContain('@guren/plugin-agents')
    expect(JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8')).durable_objects).toBeUndefined()
  })

  test('should refuse an app that registers agents without depending on the plugin', async () => {
    scaffoldAgentApp(root, { agentsPlugin: false })

    await expect(buildCloudflareOutput({ rootDir: root, skipAppBuild: true })).rejects.toThrow(
      /does not depend on/,
    )
  })

  test('should refuse the plugin declared as a devDependency', async () => {
    // wrangler resolves the generated worker's imports at deploy time, from a
    // production install, which has no devDependencies in it.
    scaffoldAgentApp(root, { agentsPlugin: false, agentsPluginAsDevDependency: true })

    await expect(buildCloudflareOutput({ rootDir: root, skipAppBuild: true })).rejects.toThrow(
      /devDependency will not do/,
    )
  })

  test('should refuse a registry with no agents object', async () => {
    scaffoldApp(root, { agentsPlugin: true })
    mkdirSync(join(root, 'config'), { recursive: true })
    writeFileSync(join(root, 'config/agents.ts'), 'export default 42\n')

    await expect(buildCloudflareOutput({ rootDir: root, skipAppBuild: true })).rejects.toThrow(
      /does not default-export a config with an "agents" object/,
    )
  })

  test('should name the registry when it cannot be evaluated on Bun', async () => {
    scaffoldApp(root, { agentsPlugin: true })
    mkdirSync(join(root, 'config'), { recursive: true })
    writeFileSync(
      join(root, 'config/agents.ts'),
      "import 'this-module-does-not-exist'\nexport default { agents: {} }\n",
    )

    await expect(buildCloudflareOutput({ rootDir: root, skipAppBuild: true })).rejects.toThrow(
      /could not evaluate config\/agents\.ts on Bun/,
    )
  })

  test('should refuse a registration whose module is not a file in the app', async () => {
    scaffoldApp(root, { agentsPlugin: true })
    writeAgentsConfig(root, { triager: { module: 'app/Agents/Missing.ts', export: 'Triager' } })

    await expect(buildCloudflareOutput({ rootDir: root, skipAppBuild: true })).rejects.toThrow(
      /not a file inside this app/,
    )
  })

  test('should refuse a module path escaping the app root', async () => {
    // The generated worker would import it fine on this machine and fail at
    // deploy, where nothing outside the app is uploaded.
    scaffoldApp(root, { agentsPlugin: true })
    writeAgentsConfig(root, { triager: { module: '../elsewhere/Triager.ts', export: 'Triager' } })

    await expect(buildCloudflareOutput({ rootDir: root, skipAppBuild: true })).rejects.toThrow(
      /not a file inside this app/,
    )
  })

  test('should refuse an export name that is not a JavaScript identifier', async () => {
    scaffoldApp(root, { agentsPlugin: true })
    writeAgentModule(root, 'app/Agents/Triager.ts', 'Triager')
    writeAgentsConfig(root, { triager: { module: 'app/Agents/Triager.ts', export: 'not a name' } })

    await expect(buildCloudflareOutput({ rootDir: root, skipAppBuild: true })).rejects.toThrow(
      /not a usable class name/,
    )
  })

  test('should refuse "default" as an export name', async () => {
    // `export { default } from` is valid syntax, and the worker already has a
    // default export.
    scaffoldApp(root, { agentsPlugin: true })
    writeAgentModule(root, 'app/Agents/Triager.ts', 'Triager')
    writeAgentsConfig(root, { triager: { module: 'app/Agents/Triager.ts', export: 'default' } })

    await expect(buildCloudflareOutput({ rootDir: root, skipAppBuild: true })).rejects.toThrow(
      /not a usable class name/,
    )
  })

  test('should refuse two exports that scaffold one binding name', async () => {
    scaffoldApp(root, { agentsPlugin: true })
    writeAgentModule(root, 'app/Agents/HTTPAgent.ts', 'HTTPAgent')
    writeAgentModule(root, 'app/Agents/HttpAgent.ts', 'HttpAgent')
    writeAgentsConfig(root, {
      upper: { module: 'app/Agents/HTTPAgent.ts', export: 'HTTPAgent' },
      camel: { module: 'app/Agents/HttpAgent.ts', export: 'HttpAgent' },
    })

    await expect(buildCloudflareOutput({ rootDir: root, skipAppBuild: true })).rejects.toThrow(
      /both scaffold the Durable Object binding "HTTP_AGENT"/,
    )
  })

  test('should refuse a routing block with no callable authorize', async () => {
    // Fail-closed at request time regardless; the build is where the typo is
    // still cheap to find.
    scaffoldApp(root, { agentsPlugin: true })
    writeAgentModule(root, 'app/Agents/Triager.ts', 'Triager')
    writeAgentsConfig(
      root,
      { triager: { module: 'app/Agents/Triager.ts', export: 'Triager' } },
      { routing: 'malformed' },
    )

    await expect(buildCloudflareOutput({ rootDir: root, skipAppBuild: true })).rejects.toThrow(
      /without a callable "authorize"/,
    )
  })

  test('should refuse two registrations claiming one export', async () => {
    scaffoldApp(root, { agentsPlugin: true })
    writeAgentModule(root, 'app/Agents/Triager.ts', 'Triager')
    writeAgentsConfig(root, {
      triager: { module: 'app/Agents/Triager.ts', export: 'Triager' },
      nightly: { module: 'app/Agents/Triager.ts', export: 'Triager' },
    })

    await expect(buildCloudflareOutput({ rootDir: root, skipAppBuild: true })).rejects.toThrow(
      /One class is one agent/,
    )
  })
})

describe('the generated worker for an app hosting agents', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'guren-cf-agent-worker-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('should export every registered class and mount the guarded router', async () => {
    scaffoldAgentApp(root)

    await captureWarnings(() => buildCloudflareOutput({ rootDir: root, skipAppBuild: true }))

    const worker = readFileSync(join(root, '.cloudflare/worker.js'), 'utf8')
    expect(worker).toContain("import { configureAgentRuntime } from \"@guren/plugin-agents/runtime\"")
    expect(worker).toContain("import { routeGuardedAgentRequest } from \"@guren/plugin-agents/agent\"")
    expect(worker).toContain('import agentsConfig from "../config/agents.ts"')
    expect(worker).toContain('const handler = createWorkersHandler(app)')
    expect(worker).toContain('configureAgentRuntime((env) => handler.boot(env))')
    expect(worker).toContain('export { Triager } from "../app/Agents/Triager.ts"')
    expect(worker).toContain('routeGuardedAgentRequest(request, env, agentsConfig.routing, agentBindings)')
    expect(worker).toContain('export default agentEntry')
    // A fresh scaffold binds the derived name, so that is the allowlist.
    expect(worker).toContain('const agentBindings = ["TRIAGER"]')
  })

  test('should allowlist the bindings the committed config gives the registered classes', async () => {
    // The SDK routes to every binding in env with an `idFromName`; the worker
    // must name the ones that host agents, under whatever names the app chose.
    scaffoldAgentApp(root)
    writeJson(join(root, 'wrangler.jsonc'), {
      name: 'legacy',
      durable_objects: {
        bindings: [
          { name: 'MY_TRIAGER', class_name: 'Triager' },
          { name: 'TRIAGER_AGAIN', class_name: 'Triager' },
          { name: 'UNRELATED', class_name: 'Counter' },
        ],
      },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['Triager', 'Counter'] }],
    })

    await captureWarnings(() => buildCloudflareOutput({ rootDir: root, skipAppBuild: true }))

    const worker = readFileSync(join(root, '.cloudflare/worker.js'), 'utf8')
    expect(worker).toContain('const agentBindings = ["MY_TRIAGER","TRIAGER_AGAIN"]')
  })

  test('should boot before routing so an authorizer can read the Workers env', async () => {
    scaffoldAgentApp(root)

    await captureWarnings(() => buildCloudflareOutput({ rootDir: root, skipAppBuild: true }))

    const worker = readFileSync(join(root, '.cloudflare/worker.js'), 'utf8')
    // The call site, not the import: the import is hoisted to the top and
    // would make this ordering assertion vacuous.
    expect(worker.indexOf('await handler.boot(env)')).toBeLessThan(
      worker.indexOf('routeGuardedAgentRequest(request'),
    )
  })

  test('should give the OAuth provider the routing entry as its default handler', async () => {
    // Both features on: one handler, so the two entrypoints share a boot slot,
    // and /agents/* stays mounted behind the provider's unprotected half.
    scaffoldAgentApp(root, { mcpPlugin: true, oauthProvider: true })
    writeJson(join(root, 'wrangler.jsonc'), hostingConfig({ kv_namespaces: [{ binding: 'OAUTH_KV', id: 'abc' }] }))

    await captureWarnings(() =>
      buildCloudflareOutput({ rootDir: root, skipAppBuild: true, mcpOAuth: true }),
    )

    const worker = readFileSync(join(root, '.cloudflare/worker.js'), 'utf8')
    expect(worker.match(/createWorkersHandler\(app\)/gu)).toHaveLength(1)
    expect(worker).toContain('defaultHandler: agentEntry')
    expect(worker).toContain('handler.fetch(presentExternalMcpAuth(request, auth), env, ctx)')
  })

  test('should warn once that the mount it just generated refuses everything', async () => {
    scaffoldAgentApp(root)

    const warning = await captureWarnings(() =>
      buildCloudflareOutput({ rootDir: root, skipAppBuild: true }),
    )

    expect(warning).toContain('refuses every request with 403')
    expect(warning).toContain('routing: { authorize:')
  })

  test('should stay silent about routing when the registry declares an authorizer', async () => {
    scaffoldApp(root, { agentsPlugin: true })
    writeAgentModule(root, 'app/Agents/Triager.ts', 'Triager')
    writeAgentsConfig(
      root,
      { triager: { module: 'app/Agents/Triager.ts', export: 'Triager' } },
      { routing: true },
    )

    const warning = await captureWarnings(() =>
      buildCloudflareOutput({ rootDir: root, skipAppBuild: true }),
    )

    expect(warning).not.toContain('403')
  })
})

describe('Durable Object bindings for registered agents', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'guren-cf-agent-bindings-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('should scaffold a SQLite-backed binding and migration for a fresh app', async () => {
    scaffoldAgentApp(root)

    await captureWarnings(() => buildCloudflareOutput({ rootDir: root, skipAppBuild: true }))

    const config = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'))
    expect(config.durable_objects.bindings).toEqual([{ name: 'TRIAGER', class_name: 'Triager' }])
    // `new_sqlite_classes`, never `new_classes`: the SDK keeps everything an
    // Agent owns in Durable Object SQLite, so a KV-backed class cannot host one.
    expect(config.migrations).toEqual([{ tag: 'v1', new_sqlite_classes: ['Triager'] }])
    expect(config.compatibility_flags).toContain('nodejs_compat')
  })

  test('should accept a committed config using the legacy migrations list', async () => {
    scaffoldAgentApp(root)
    writeJson(join(root, 'wrangler.jsonc'), hostingConfig())

    await captureWarnings(() => buildCloudflareOutput({ rootDir: root, skipAppBuild: true }))

    expect(readFileSync(join(root, '.cloudflare/worker.js'), 'utf8')).toContain('export { Triager }')
  })

  test('should accept the declarative exports form, which replaces migrations', async () => {
    scaffoldAgentApp(root)
    writeJson(join(root, 'wrangler.jsonc'), {
      name: 'legacy',
      durable_objects: { bindings: [{ name: 'TRIAGER', class_name: 'Triager' }] },
      exports: { Triager: { type: 'durable-object', storage: 'sqlite' } },
    })

    await captureWarnings(() => buildCloudflareOutput({ rootDir: root, skipAppBuild: true }))

    expect(readFileSync(join(root, '.cloudflare/worker.js'), 'utf8')).toContain('export { Triager }')
  })

  test('should refuse a declarative export the config declares deleted', async () => {
    scaffoldAgentApp(root)
    writeJson(join(root, 'wrangler.jsonc'), {
      name: 'legacy',
      durable_objects: { bindings: [{ name: 'TRIAGER', class_name: 'Triager' }] },
      // Present in the map, but declaring the class *gone* rather than hosted.
      exports: { Triager: { type: 'durable-object', state: 'deleted' } },
    })

    await expect(buildCloudflareOutput({ rootDir: root, skipAppBuild: true })).rejects.toThrow(
      /SQLite-backed Durable Objects/,
    )
  })

  test('should name the exact JSON to add when nothing hosts the class', async () => {
    scaffoldAgentApp(root)
    writeJson(join(root, 'wrangler.jsonc'), { name: 'legacy', main: '.cloudflare/worker.js' })

    const error = await buildCloudflareOutput({ rootDir: root, skipAppBuild: true }).catch(
      (thrown: Error) => thrown,
    )

    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain('"name": "TRIAGER"')
    expect(message).toContain('"class_name": "Triager"')
    expect(message).toContain('"tag": "v1"')
    expect(message).toContain('"new_sqlite_classes"')
  })

  test('should suggest the tag after the highest one the file already has', async () => {
    scaffoldAgentApp(root)
    writeJson(join(root, 'wrangler.jsonc'), {
      name: 'legacy',
      durable_objects: { bindings: [{ name: 'TRIAGER', class_name: 'Triager' }] },
      migrations: [{ tag: 'v1', new_classes: ['Other'] }, { tag: 'v2', new_classes: ['Another'] }],
    })

    const error = await buildCloudflareOutput({ rootDir: root, skipAppBuild: true }).catch(
      (thrown: Error) => thrown,
    )

    // Reusing a tag is rejected by wrangler, so a suggestion has to count.
    expect((error as Error).message).toContain('"tag": "v3"')
    // The binding is already there, so only the missing half is suggested.
    expect((error as Error).message).not.toContain('"class_name"')
  })

  test('should refuse a config that minifies the worker it hosts agents from', async () => {
    // Identifier mangling renames the class an agent looks itself up by.
    scaffoldAgentApp(root)
    writeJson(join(root, 'wrangler.jsonc'), hostingConfig({ minify: true }))

    await expect(buildCloudflareOutput({ rootDir: root, skipAppBuild: true })).rejects.toThrow(
      /"minify": true/,
    )
  })

  test('should read the migrations list as history, not as a set of declarations', async () => {
    scaffoldAgentApp(root)
    writeJson(join(root, 'wrangler.jsonc'), {
      name: 'legacy',
      durable_objects: { bindings: [{ name: 'TRIAGER', class_name: 'Triager' }] },
      // Created, then deleted: the class is gone, however many entries name it.
      migrations: [
        { tag: 'v1', new_sqlite_classes: ['Triager'] },
        { tag: 'v2', deleted_classes: ['Triager'] },
      ],
    })

    await expect(buildCloudflareOutput({ rootDir: root, skipAppBuild: true })).rejects.toThrow(
      /SQLite-backed Durable Objects/,
    )
  })

  test('should carry the storage backend through a rename', async () => {
    scaffoldAgentApp(root)
    writeJson(join(root, 'wrangler.jsonc'), {
      name: 'legacy',
      durable_objects: { bindings: [{ name: 'TRIAGER', class_name: 'Triager' }] },
      migrations: [
        { tag: 'v1', new_sqlite_classes: ['Sorter'] },
        { tag: 'v2', renamed_classes: [{ from: 'Sorter', to: 'Triager' }] },
      ],
    })

    await captureWarnings(() => buildCloudflareOutput({ rootDir: root, skipAppBuild: true }))

    expect(readFileSync(join(root, '.cloudflare/worker.js'), 'utf8')).toContain('export { Triager }')
  })

  test('should accept a declarative export awaiting a transfer', async () => {
    scaffoldAgentApp(root)
    writeJson(join(root, 'wrangler.jsonc'), {
      name: 'legacy',
      durable_objects: { bindings: [{ name: 'TRIAGER', class_name: 'Triager' }] },
      exports: {
        Triager: { type: 'durable-object', state: 'expecting-transfer', storage: 'sqlite', transfer_from: 'Old' },
      },
    })

    await captureWarnings(() => buildCloudflareOutput({ rootDir: root, skipAppBuild: true }))

    expect(readFileSync(join(root, '.cloudflare/worker.js'), 'utf8')).toContain('export { Triager }')
  })

  test('should not count a binding to another Worker as hosting the class', async () => {
    scaffoldAgentApp(root)
    writeJson(join(root, 'wrangler.jsonc'), {
      name: 'legacy',
      // `script_name` points at a class in a different Worker, not at the
      // export this build generates.
      durable_objects: { bindings: [{ name: 'TRIAGER', class_name: 'Triager', script_name: 'elsewhere' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['Triager'] }],
    })

    await expect(buildCloudflareOutput({ rootDir: root, skipAppBuild: true })).rejects.toThrow(
      /"class_name": "Triager"/,
    )
  })

  test('should verify every named environment, which does not inherit bindings', async () => {
    scaffoldAgentApp(root)
    writeJson(join(root, 'wrangler.jsonc'), hostingConfig({ env: { production: { name: 'legacy-prod' } } }))

    await expect(buildCloudflareOutput({ rootDir: root, skipAppBuild: true })).rejects.toThrow(
      /\(env\.production\) does not host/,
    )
  })

  test('should refuse minification set on a named environment alone', async () => {
    scaffoldAgentApp(root)
    writeJson(
      join(root, 'wrangler.jsonc'),
      hostingConfig({
        env: {
          production: {
            minify: true,
            durable_objects: { bindings: [{ name: 'TRIAGER', class_name: 'Triager' }] },
          },
        },
      }),
    )

    await expect(buildCloudflareOutput({ rootDir: root, skipAppBuild: true })).rejects.toThrow(
      /\(env\.production\) sets "minify": true/,
    )
  })

  test('should refuse a class bound with the legacy KV storage backend', async () => {
    scaffoldAgentApp(root)
    writeJson(join(root, 'wrangler.jsonc'), {
      name: 'legacy',
      durable_objects: { bindings: [{ name: 'TRIAGER', class_name: 'Triager' }] },
      migrations: [{ tag: 'v1', new_classes: ['Triager'] }],
    })

    await expect(buildCloudflareOutput({ rootDir: root, skipAppBuild: true })).rejects.toThrow(
      /SQLite-backed Durable Objects/,
    )
  })

  test('should refuse before the output directory is rebuilt', async () => {
    scaffoldAgentApp(root)
    writeJson(join(root, 'wrangler.jsonc'), { name: 'legacy' })
    writeFileSync(join(root, 'previous.txt'), 'previous deploy\n')

    await expect(buildCloudflareOutput({ rootDir: root, skipAppBuild: true })).rejects.toThrow()

    // The one thing a failed build may not do is take the last deploy with it.
    expect(readFileSync(join(root, 'previous.txt'), 'utf8')).toBe('previous deploy\n')
  })

  test('should warn that a config it cannot parse went unchecked', async () => {
    scaffoldAgentApp(root)
    writeFileSync(join(root, 'wrangler.jsonc'), '{ "name": "legacy", oops }\n')

    const warning = await captureWarnings(() =>
      buildCloudflareOutput({ rootDir: root, skipAppBuild: true }),
    )

    expect(warning).toContain('went unchecked')
    expect(readFileSync(join(root, '.cloudflare/worker.js'), 'utf8')).toContain('export { Triager }')
  })
})
