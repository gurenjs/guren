import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  AGENTS_CONFIG_FILE,
  appUsesMcpPlugin,
  DEV_ONLY_MODULES,
  MCP_PLUGIN_PACKAGE,
  MCP_TRANSPORT_SPECIFIER,
  SQL_CLIENT_MODULES,
  clientManifestJson,
  DOCUMENT_ASSET_EXTENSIONS,
  DOCUMENT_ASSET_HEADERS,
  importSpecifier,
  renderDevOnlyStub,
  stubbableDevOnlyModules,
  assertOutputDirOutsideRoot,
  resetOutputDir,
  resolveClientAssetEnv,
  resolvePathLike,
  resolveSsrEntryFile,
  stageStaticAssets,
  type ClientAssetEnv,
  type DevOnlySpecifier,
  type SqlClientSpecifier,
  type PathLike,
} from '@guren/core/internal/deploy-build'

import {
  MCP_OAUTH_REGISTRAR,
  MCP_OAUTH_ROUTES_FILE,
  MCP_OAUTH_TEMPLATE_FILES,
  loadMcpOAuthTemplate,
} from './templates'

interface PackageJsonLike {
  name?: string
  scripts?: Record<string, string>
}

export interface BuildCloudflareOutputOptions {
  /** App root directory. Defaults to the current working directory. */
  rootDir?: PathLike
  /** Output directory for the assembled worker. Defaults to `<root>/.cloudflare`. */
  outputDir?: PathLike
  /** Module that default-exports the Guren Application. Defaults to `<root>/src/app.ts`. */
  appEntry?: PathLike
  /** Static files directory copied into Workers Static Assets. Defaults to `<root>/public`. */
  publicDir?: PathLike
  /** Vite SSR build output. Defaults to `<root>/.guren/ssr`. */
  ssrDir?: PathLike
  /** Client manifest key for the frontend entry. Defaults to `resources/js/app.tsx`. */
  clientEntryKey?: string
  /** SSR manifest key for the server entry. Defaults to `resources/js/ssr.tsx`. */
  ssrEntryKey?: string
  /** Skip running the app's `build` script before assembling output. */
  skipAppBuild?: boolean
  /**
   * Front the worker with `@cloudflare/workers-oauth-provider`, so the App MCP
   * endpoint is reached by OAuth-authorized clients instead of bearer tokens
   * (RFC 0016 §7). A **build** option, not plugin configuration: the generator
   * runs in another process and cannot read what `mcpPlugin()` was passed, and
   * nothing records the choice, so pass it on every build that wants it.
   */
  mcpOAuth?: boolean
  /**
   * Path the App MCP endpoint is mounted at, used as the OAuth provider's
   * protected `apiRoute`. Only read when `mcpOAuth` is on. Defaults to
   * `mcpPlugin()`'s own default; an app that passed `mcpPlugin({ path })` must
   * repeat it here — a provider protecting a path the endpoint does not serve
   * leaves the endpoint outside the OAuth boundary silently.
   */
  mcpPath?: string
}

/**
 * Assemble a deployable Cloudflare Workers directory (`.cloudflare/`) from a
 * built Guren app: a generated worker entry that statically wires the SSR
 * bundle, static assets for Workers Static Assets, and a one-time
 * `wrangler.jsonc` scaffold. Deploy with `wrangler deploy`.
 */
export async function buildCloudflareOutput(options: BuildCloudflareOutputOptions = {}): Promise<void> {
  const root = resolvePathLike(options.rootDir ?? process.cwd())
  const out = resolvePathLike(options.outputDir ?? resolve(root, '.cloudflare'))
  const appEntry = resolvePathLike(options.appEntry ?? resolve(root, 'src/app.ts'))
  const publicDir = resolvePathLike(options.publicDir ?? resolve(root, 'public'))
  const ssrDir = resolvePathLike(options.ssrDir ?? resolve(root, '.guren/ssr'))
  const clientEntryKey = options.clientEntryKey ?? 'resources/js/app.tsx'
  const ssrEntryKey = options.ssrEntryKey ?? 'resources/js/ssr.tsx'

  // Validated up front so a bad option fails before running the app build,
  // but the delete waits until every check below has passed — a failed build
  // must not take the previous deploy output with it.
  assertOutputDirOutsideRoot(out, root, 'Cloudflare build')
  assertWranglerJsoncIsAuthoritative(root)

  const packageJson = readPackageJson(root)
  // The App MCP opt-in is decided once and threaded to both halves below (the
  // guard on the committed config and the alias set the scaffold writes), so the
  // two cannot disagree. Parsing package.json twice is cheap; deciding twice is not.
  const mcpPlugin = appUsesMcpPlugin(root)

  const mcpOAuth = options.mcpOAuth === true
  const mcpPath = options.mcpPath ?? DEFAULT_MCP_PATH

  // Checked before the app build: these are one-line edits to files the developer
  // owns, and reporting them after minutes of Vite output is reporting them where
  // nobody reads.
  assertMcpTransportNotAliased(root, mcpPlugin)
  if (mcpOAuth) {
    assertMcpOAuthUsable(root, mcpPlugin)
    assertOAuthKvBound(root)
  }

  const hostsAgents = existsSync(resolve(root, AGENTS_CONFIG_FILE))
  if (hostsAgents) {
    // Before the registry is read, not after: reading it evaluates a file that
    // imports the plugin, so an app that never installed it would fail with the
    // module resolver's message instead of the one carrying the fix.
    assertAgentsPluginUsable(root)
  }
  const agents = hostsAgents ? await readAgentRegistry(root) : NO_AGENTS
  const agentBindings = assertAgentDurableObjects(root, agents.exports)
  warnUnroutedAgents(agents)

  if (!options.skipAppBuild) {
    runAppBuild(root, packageJson.scripts ?? {})
  }

  if (!existsSync(appEntry)) {
    throw new Error(`Cloudflare build: app entry not found at ${appEntry}. Pass "appEntry" if your Application lives elsewhere.`)
  }

  const ssrImport = await resolveSsrImport(ssrDir, ssrEntryKey)
  const assetEnv = resolveClientAssetEnv(publicDir, clientEntryKey, 'Cloudflare build')
  const viteManifest = clientManifestJson(publicDir)

  resetOutputDir(out, root, 'Cloudflare build')

  // Workers Static Assets serves `/` from index.html BEFORE the worker runs,
  // and has no rewrites for the built assets' `/public/assets/` base — both
  // handled by the shared staging step.
  stageStaticAssets(publicDir, resolve(out, 'assets'))
  writeAssetHeaders(resolve(out, 'assets'))

  const workerEnv = renderWorkerEnvModule({ assetEnv, viteManifest })
  if (workerEnv) {
    writeFileSync(resolve(out, 'worker-env.js'), workerEnv)
  }
  writeFileSync(
    resolve(out, 'worker.js'),
    renderWorkerModule({
      out,
      appEntry,
      ssrImport,
      hasEnvModule: workerEnv !== undefined,
      mcpOAuth,
      mcpPath,
      root,
      agents: agents.exports,
      agentBindings,
    }),
  )

  flattenD1Migrations(resolve(root, 'db/migrations'), resolve(out, 'd1-migrations'))

  writeDevOnlyStubs(out)

  if (mcpOAuth) {
    scaffoldConsentFlow(root)
  }

  scaffoldWranglerConfig(root, out, packageJson.name, mcpPlugin, mcpOAuth, agents.exports)
}

const MCP_UNAVAILABLE = 'The MCP endpoint is unavailable on Cloudflare Workers — it generates files on disk.'

/** `mcpPlugin()`'s own default mount path — see `BuildCloudflareOutputOptions.mcpPath`. */
const DEFAULT_MCP_PATH = '/mcp'

/** The OAuth provider package the generated worker imports, installed by the app. */
const OAUTH_PROVIDER_PACKAGE = '@cloudflare/workers-oauth-provider'

/** The subpath of `@guren/plugin-mcp` carrying the principal seam. */
const MCP_OAUTH_SEAM_SPECIFIER = '@guren/plugin-mcp/oauth'

/** The KV binding name `OAuthProvider` requires, fixed by the provider. */
const OAUTH_KV_BINDING = 'OAUTH_KV'

/** The three endpoints the provider owns or hands back, in one place. */
const OAUTH_ENDPOINTS = {
  authorize: '/oauth/authorize',
  token: '/oauth/token',
  register: '/oauth/register',
} as const

/**
 * Refuse `--mcp-oauth` on an app that cannot serve it, before anything is built.
 * Both prerequisites are the app's own `dependencies`: `@guren/plugin-mcp` (else
 * there is no endpoint to front and the seam module is not installed) and
 * `@cloudflare/workers-oauth-provider`, which wrangler resolves from the *app's*
 * `node_modules` at `wrangler deploy`, from a production install — not devDeps.
 */
function assertMcpOAuthUsable(root: string, mcpPlugin: boolean): void {
  if (!mcpPlugin) {
    throw new Error(
      `Cloudflare build: --mcp-oauth fronts the App MCP endpoint with an OAuth provider, but this app does not depend on ${MCP_PLUGIN_PACKAGE}, so it serves no such endpoint. Install and mount the plugin first:\n`
      + `  bun add ${MCP_PLUGIN_PACKAGE}\n`
      + '  # then add mcpPlugin() to createApp({ providers })\n'
      + 'Or drop --mcp-oauth to build the worker without the OAuth wrapping.',
    )
  }

  if (!appDependsOn(root, OAUTH_PROVIDER_PACKAGE)) {
    throw new Error(
      `Cloudflare build: --mcp-oauth generates a worker that imports ${OAUTH_PROVIDER_PACKAGE}, which this app does not depend on. Install it:\n`
      + `  bun add ${OAUTH_PROVIDER_PACKAGE}\n`
      + `It is not a dependency of @guren/plugin-cloudflare on purpose — only apps fronting the MCP endpoint with OAuth need it. A devDependency will not do: wrangler resolves the import at deploy time, from a production install.`,
    )
  }
}

/**
 * `OAuthProvider` stores clients, grants and tokens in a KV namespace bound as
 * `OAUTH_KV`, with no default: unbound, the worker deploys and fails on its
 * first authorize request. Checked only while the flag is on. A fresh scaffold
 * gets the entry written; an existing `wrangler.jsonc` fails rather than warns,
 * since the fix is exact JSON. Unparseable configs: {@link warnMissingBuildOwnedKeys}.
 */
function assertOAuthKvBound(root: string): void {
  const configPath = resolve(root, 'wrangler.jsonc')
  const config = readWranglerConfig(configPath)
  if (!config) {
    return
  }

  const bound = oauthKvBinding(config)
  if (bound) {
    // Present, but still carrying the placeholder id this build scaffolds, which
    // `wrangler deploy` rejects. Warned rather than failed: the id is not needed
    // to *build*, and a --dry-run deploy on an unfinished config is reasonable.
    if (bound.id === oauthKvNamespace().id) {
      console.warn(
        `Cloudflare build: ${configPath} still has the scaffolded placeholder id for the ${OAUTH_KV_BINDING} binding, so a real deploy will be rejected. Create the namespace and paste its id in:\n`
        + `  wrangler kv namespace create ${OAUTH_KV_BINDING}`,
      )
    }
    return
  }

  throw new Error(
    `Cloudflare build: --mcp-oauth needs a KV namespace bound as ${OAUTH_KV_BINDING} — the OAuth provider stores its clients, grants and tokens there — and ${configPath} has none. Create one and add this entry, alongside whatever the file already has:\n`
    + `  "kv_namespaces": [\n`
    + `    ${JSON.stringify(oauthKvNamespace(), null, 2).split('\n').join('\n    ')}\n`
    + `  ]\n`
    + `Get the id from: wrangler kv namespace create ${OAUTH_KV_BINDING}`,
  )
}

/**
 * The KV namespace a parsed config binds under the provider's name, or
 * `undefined`. Returns the entry rather than a boolean because callers ask both
 * "is it bound" and "is its id still the placeholder" of the same match.
 */
function oauthKvBinding(config: Record<string, unknown>): Record<string, unknown> | undefined {
  const namespaces = config.kv_namespaces
  if (!Array.isArray(namespaces)) {
    return undefined
  }

  return namespaces.find(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) && entry.binding === OAUTH_KV_BINDING,
  )
}

/** The binding entry, spelled once — the scaffold writes it, the guard quotes it. */
function oauthKvNamespace(): Record<string, string> {
  return { binding: OAUTH_KV_BINDING, id: `TODO: wrangler kv namespace create ${OAUTH_KV_BINDING}` }
}

/**
 * Whether the app declares `name` under `dependencies`. Same answer-shape as
 * `appUsesMcpPlugin` in `@guren/core/internal/deploy-build`: an absent,
 * unreadable or malformed manifest answers `false`.
 */
function appDependsOn(root: string, name: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const dependencies = manifest.dependencies
    return typeof dependencies === 'object' && dependencies !== null && name in dependencies
  } catch {
    return false
  }
}

/** The package the generated worker imports the agent runtime and router from. */
const AGENTS_PLUGIN_PACKAGE = '@guren/plugin-agents'

/** Its two subpaths: the boot seam, and the workerd-only routing half. */
const AGENTS_RUNTIME_SPECIFIER = `${AGENTS_PLUGIN_PACKAGE}/runtime`
const AGENTS_ROUTER_SPECIFIER = `${AGENTS_PLUGIN_PACKAGE}/agent`

/** One registered agent, as much of it as the generated worker needs. */
interface AgentExport {
  /** The `agents` key, named in refusals so the reader can find the entry. */
  agent: string
  /** Project-relative path to the module holding the class. */
  module: string
  /** The exported class name — a Durable Object's `class_name`. */
  export: string
}

interface AgentRegistry {
  exports: AgentExport[]
  /** Whether `routing` is declared; without it `/agents/*` is deny-all. */
  routing: boolean
}

const NO_AGENTS: AgentRegistry = { exports: [], routing: false }

/**
 * Read `config/agents.ts` by evaluating it, the way `guren dev` does. RFC 0017
 * §3's static grammar is what makes that safe here: literal strings, nothing
 * imported from `agents` or `cloudflare:workers`, so it evaluates on Bun.
 * Duck-typed rather than typed against the plugin, which this package
 * deliberately does not depend on.
 */
async function readAgentRegistry(root: string): Promise<AgentRegistry> {
  const configPath = resolve(root, AGENTS_CONFIG_FILE)
  let module: { default?: unknown }
  try {
    module = (await import(pathToFileURL(configPath).href)) as { default?: unknown }
  } catch (error) {
    throw new Error(
      `Cloudflare build: could not evaluate ${AGENTS_CONFIG_FILE} on Bun: ${error instanceof Error ? error.message : String(error)}\n`
      + 'The registry is evaluated outside workerd, so nothing it imports may exist only there (`agents`, `cloudflare:workers`). Keep the agent classes in their own modules and name them by path.',
      { cause: error },
    )
  }
  const config = module.default

  if (!isRecord(config) || !isRecord(config.agents)) {
    throw new Error(
      `Cloudflare build: ${AGENTS_CONFIG_FILE} does not default-export a config with an "agents" object, so this build cannot tell which classes are Durable Objects. Write it as:\n`
      + `  export default defineAgentsConfig({ agents: { triager: { module: 'app/Agents/Triager.ts', export: 'Triager', scopes: ['tools:read'] } } })`,
    )
  }

  const exports: AgentExport[] = []
  const claimed = new Map<string, string>()
  const claimedBindings = new Map<string, string>()

  for (const [agent, registration] of Object.entries(config.agents)) {
    const fields: Record<string, unknown> = isRecord(registration) ? registration : {}
    const modulePath = fields.module
    const exportName = fields.export

    if (typeof modulePath !== 'string' || modulePath.trim() === '') {
      throw new Error(agentRegistrationError(agent, 'has no `module`', "module: 'app/Agents/Triager.ts'"))
    }
    // `default` is an identifier `export { default } from` accepts, and the
    // worker already has a default export; a class cannot be named it anyway.
    if (typeof exportName !== 'string' || !IDENTIFIER_PATTERN.test(exportName) || exportName === 'default') {
      throw new Error(
        agentRegistrationError(
          agent,
          `names the export ${JSON.stringify(exportName)}, which is not a usable class name — the generated worker writes it into an \`export { … }\` line`,
          "export: 'Triager'",
        ),
      )
    }

    const file = resolve(root, modulePath)
    if (!isInside(root, file) || !existsSync(file)) {
      throw new Error(
        agentRegistrationError(
          agent,
          `names the module "${modulePath}", which is not a file inside this app`,
          "module: 'app/Agents/Triager.ts'",
        ),
      )
    }

    const claimedBy = claimed.get(exportName)
    if (claimedBy !== undefined) {
      throw new Error(
        `Cloudflare build: ${AGENTS_CONFIG_FILE} registers the export "${exportName}" for both "${claimedBy}" and "${agent}". One class is one agent: the generated worker exports each name once, and a Durable Object binding names exactly one class.`,
      )
    }
    claimed.set(exportName, agent)

    // `HTTPAgent` and `HttpAgent` are two classes but one `HTTP_AGENT` binding;
    // wrangler would see the duplicate only at deploy.
    const binding = durableObjectBindingName(exportName)
    const bindingClaimedBy = claimedBindings.get(binding)
    if (bindingClaimedBy !== undefined) {
      throw new Error(
        `Cloudflare build: ${AGENTS_CONFIG_FILE} registers the exports "${bindingClaimedBy}" and "${exportName}", which both scaffold the Durable Object binding "${binding}". Rename one so each class gets a binding of its own.`,
      )
    }
    claimedBindings.set(binding, exportName)

    exports.push({ agent, module: modulePath, export: exportName })
  }

  return { exports, routing: hasRouting(config) }
}

/**
 * `routing` is absent or an object with a callable `authorize`. Anything else
 * (`routing: {}`, `authorize: true`) would be refused at request time as
 * unconfigured while the build stayed silent — the one diagnostic this
 * feature offers, defeated by a typo.
 */
function hasRouting(config: Record<string, unknown>): boolean {
  const routing = config.routing
  if (routing === undefined) {
    return false
  }
  if (isRecord(routing) && typeof routing.authorize === 'function') {
    return true
  }

  throw new Error(
    `Cloudflare build: ${AGENTS_CONFIG_FILE} declares "routing" without a callable "authorize", so it neither opens /agents/* nor reads as the deny-all default. Write \`routing: { authorize: (request, target) => … }\`, or remove "routing" to keep every request refused.`,
  )
}

/** What a JavaScript `export { … }` clause will accept as a name. */
const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/

function agentRegistrationError(agent: string, problem: string, fix: string): string {
  return (
    `Cloudflare build: the agent "${agent}" in ${AGENTS_CONFIG_FILE} ${problem}. `
    + `The generated worker needs both a module and an export name to write \`export { Class } from '…'\`, or the Durable Object binding points at nothing. Fix: \`${fix}\`.`
  )
}

/** Whether `target` is the directory `root` or something under it. */
function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(`..${sep}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Refuse an app hosting agents that did not install the plugin, before anything
 * is built. Same shape as {@link assertMcpOAuthUsable}: wrangler resolves the
 * generated worker's imports at deploy time, from a *production* install, so a
 * devDependency does not answer.
 */
function assertAgentsPluginUsable(root: string): void {
  if (appDependsOn(root, AGENTS_PLUGIN_PACKAGE)) {
    return
  }

  throw new Error(
    `Cloudflare build: ${AGENTS_CONFIG_FILE} registers durable agents, so the generated worker imports ${AGENTS_PLUGIN_PACKAGE} — which this app does not depend on. Install it:\n`
    + `  bun add ${AGENTS_PLUGIN_PACKAGE}\n`
    + `  # then add agentsPlugin(agents) to createApp({ providers })\n`
    + `A devDependency will not do: wrangler resolves the import at deploy time, from a production install. Or delete ${AGENTS_CONFIG_FILE} to build a worker without agents.`,
  )
}

/**
 * Say once, at build time, that the mount the worker just gained refuses
 * everything. Nothing else reports it: the deploy succeeds, the agents run on
 * their alarms, and only an inbound request meets the 403.
 */
function warnUnroutedAgents(agents: AgentRegistry): void {
  if (agents.exports.length === 0 || agents.routing) {
    return
  }

  console.warn(
    `Cloudflare build: ${AGENTS_CONFIG_FILE} declares no "routing", so /agents/* on the generated worker refuses every request with 403 and no Durable Object is constructed. That is the default on purpose (RFC 0017 §6). To let callers in, add:\n`
    + '  routing: { authorize: (request, target) => /* your check */ false }',
  )
}

/**
 * Verify the committed config hosts every registered agent, before the app
 * build, and return the binding names that host them — the generated worker's
 * routing allowlist. Both halves are required: a class with no `durable_objects`
 * binding is unreachable, and one that is not SQLite-backed cannot host an
 * `Agent` (the SDK keeps state, schedules and bookkeeping in Durable Object SQLite).
 */
function assertAgentDurableObjects(root: string, agents: AgentExport[]): string[] {
  if (agents.length === 0) {
    return []
  }
  const configPath = resolve(root, 'wrangler.jsonc')
  if (!existsSync(configPath)) {
    // The scaffolded wrangler.jsonc binds exactly these.
    return agents.map((agent) => durableObjectBindingName(agent.export))
  }

  const config = readWranglerConfig(configPath)
  if (!config) {
    console.warn(
      `Cloudflare build: could not parse ${configPath}, so the Durable Object configuration for the registered agents went unchecked. An agent with no binding deploys and then answers nothing, and /agents/* will refuse every binding.`,
    )
    return []
  }

  const bindings = new Set<string>()
  // `durable_objects` is not inherited by a named environment (wrangler's schema
  // says so), so each one is verified on its own; `minify` and the storage
  // declarations fall back to the top level the way wrangler inherits them.
  for (const scope of configScopes(config)) {
    assertAgentScopeHosts(configPath, scope, config, agents)
    for (const binding of registeredBindings(scope.config, agents)) {
      bindings.add(binding.name)
    }
  }

  return [...bindings]
}

interface ConfigScope {
  /** `""` for the top level, ` (env.<name>)` for a named environment. */
  label: string
  config: Record<string, unknown>
}

function configScopes(config: Record<string, unknown>): ConfigScope[] {
  const scopes: ConfigScope[] = [{ label: '', config }]
  if (isRecord(config.env)) {
    for (const [name, environment] of Object.entries(config.env)) {
      if (isRecord(environment)) scopes.push({ label: ` (env.${name})`, config: environment })
    }
  }
  return scopes
}

/** One scope's verdict: mangling refused, every registered class bound and SQLite-backed. */
function assertAgentScopeHosts(
  configPath: string,
  scope: ConfigScope,
  topLevel: Record<string, unknown>,
  agents: AgentExport[],
): void {
  const where = `${configPath}${scope.label}`

  // An agent finds its registration by `this.constructor.name`, so wrangler's
  // identifier mangling turns a clean deploy into "is not registered" on every
  // tool call — the one Guren deploy target where the class-name rule fails at
  // runtime rather than in a log line.
  if ((scope.config.minify ?? topLevel.minify) === true) {
    throw new Error(
      `Cloudflare build: ${where} sets "minify": true, and this app hosts agents. wrangler's minifier renames identifiers, and an agent class is looked up by its runtime name — mangled, every tool call fails with "is not registered" after a deploy that looked fine. Remove "minify" from the config.`,
    )
  }

  const bound = new Set(registeredBindings(scope.config, agents).map((binding) => binding.class_name))
  const declaresStorage = Array.isArray(scope.config.migrations) || isRecord(scope.config.exports)
  const sqlite = sqliteBackedClasses(declaresStorage ? scope.config : topLevel)
  const unbound = agents.filter((agent) => !bound.has(agent.export))
  const unbacked = agents.filter((agent) => !sqlite.has(agent.export))

  if (unbound.length === 0 && unbacked.length === 0) {
    return
  }

  const fixes: string[] = []
  if (unbound.length > 0) {
    const bindings = unbound.map((agent) => ({
      name: durableObjectBindingName(agent.export),
      class_name: agent.export,
    }))
    fixes.push(indentJson({ durable_objects: { bindings } }))
  }
  if (unbacked.length > 0) {
    const classes = unbacked.map((agent) => agent.export)
    fixes.push(indentJson({ migrations: [{ tag: nextMigrationTag(topLevel), new_sqlite_classes: classes }] }))
  }

  const names = [...new Set([...unbound, ...unbacked].map((agent) => agent.export))].join(', ')
  throw new Error(
    `Cloudflare build: ${where} does not host the registered agent(s) ${names} as SQLite-backed Durable Objects. Add these entries, alongside whatever the file already has under the same keys:\n`
    + `${fixes.join('\n')}\n`
    + 'The declarative form is accepted too — `"exports": { "Triager": { "type": "durable-object", "storage": "sqlite" } }` — but wrangler treats it as mutually exclusive with "migrations", so use one or the other.',
  )
}

/** `Triager` → `TRIAGER`, `TriagerAgent` → `TRIAGER_AGENT`. */
function durableObjectBindingName(exportName: string): string {
  return exportName
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toUpperCase()
}

function indentJson(value: unknown): string {
  return `  ${JSON.stringify(value, null, 2).slice(1, -1).trim()}`.replace(/\n/g, '\n  ')
}

interface DurableObjectBinding {
  name: string
  class_name: string
}

/**
 * The bindings in one scope whose class is a registered agent. A binding with a
 * `script_name` points at another Worker's class, not at the export this build
 * generates, so it is neither hosting nor routable here.
 */
function registeredBindings(config: Record<string, unknown>, agents: AgentExport[]): DurableObjectBinding[] {
  const registered = new Set(agents.map((agent) => agent.export))
  const durableObjects = config.durable_objects
  const hosting: DurableObjectBinding[] = []

  for (const entry of asArray(isRecord(durableObjects) ? durableObjects.bindings : undefined)) {
    if (!isRecord(entry)) continue
    const { name, class_name: className, script_name: scriptName } = entry
    if (scriptName !== undefined) continue
    if (typeof name !== 'string' || typeof className !== 'string') continue
    if (!registered.has(className)) continue
    hosting.push({ name, class_name: className })
  }

  return hosting
}

/**
 * Classes wrangler will give a SQLite storage backend, in either form. The
 * `migrations` list is *history*, folded in order: a class created in `v1` and
 * deleted in `v2` is gone, a rename carries the backend to the new name. A
 * declarative `exports` entry counts while it is live — `created` (the default)
 * or `expecting-transfer` — and `deleted`/`renamed` declare the class gone.
 */
function sqliteBackedClasses(config: Record<string, unknown>): Set<string> {
  const classes = new Set<string>()

  for (const migration of asArray(config.migrations)) {
    if (!isRecord(migration)) continue
    for (const name of strings(migration.new_sqlite_classes)) classes.add(name)
    for (const rename of asArray(migration.renamed_classes)) {
      if (!isRecord(rename) || typeof rename.from !== 'string' || typeof rename.to !== 'string') continue
      if (classes.delete(rename.from)) classes.add(rename.to)
    }
    for (const name of strings(migration.deleted_classes)) classes.delete(name)
  }

  const exported = config.exports
  if (isRecord(exported)) {
    for (const [name, entry] of Object.entries(exported)) {
      if (!isRecord(entry)) continue
      const live = entry.state === undefined || entry.state === 'created' || entry.state === 'expecting-transfer'
      if (entry.type === 'durable-object' && entry.storage === 'sqlite' && live) classes.add(name)
    }
  }

  return classes
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function strings(value: unknown): string[] {
  return asArray(value).filter((entry): entry is string => typeof entry === 'string')
}

/** The tag after the highest `v<n>` already in the file, or `v1`. */
function nextMigrationTag(config: Record<string, unknown>): string {
  const migrations = Array.isArray(config.migrations) ? config.migrations : []
  let highest = 0

  for (const migration of migrations) {
    const tag = isRecord(migration) ? migration.tag : undefined
    const match = typeof tag === 'string' ? /^v(\d+)$/.exec(tag) : null
    if (match) highest = Math.max(highest, Number(match[1]))
  }

  return `v${highest + 1}`
}

/**
 * Both lists: on Workers the SQL clients are as unreachable as the dev-only
 * modules, because D1 is the only database the platform has.
 */
const STUBBED_MODULES = [...DEV_ONLY_MODULES, ...SQL_CLIENT_MODULES]

/**
 * Why the stubbed modules cannot run here, worded for this platform: each
 * names the Workers-appropriate replacement.
 */
const UNAVAILABLE_ON_WORKERS: Record<(typeof STUBBED_MODULES)[number]['kind'], string> = {
  sqlite: 'bun:sqlite is unavailable on Cloudflare Workers — use createD1Database().',
  vite: 'The Vite dev server is unavailable on Cloudflare Workers — assets are served by Workers Static Assets.',
  mcp: MCP_UNAVAILABLE,
  'sql-driver':
    'This database client is unavailable on Cloudflare Workers — use createD1Database(). '
    + 'It is stubbed because @guren/orm names it in a dynamic import that bundlers follow '
    + 'even when the branch cannot be taken.',
}

/**
 * Wrangler resolves an `alias` to a path on disk, so each stub needs a file of
 * its own. The names are hand-written rather than derived: they are baked into
 * every app's committed `wrangler.jsonc`, which the scaffold never overwrites.
 * Keyed on `DevOnlySpecifier`, so a new `DEV_ONLY_MODULES` entry is a compile
 * error here until it gets a filename.
 */
const STUB_FILES: Record<DevOnlySpecifier | SqlClientSpecifier, string> = {
  'bun:sqlite': 'stub-bun-sqlite.js',
  vite: 'stub-vite.js',
  '@guren/cli': 'stub-guren-cli.js',
  '@modelcontextprotocol/sdk/server/mcp.js': 'stub-mcp-server.js',
  '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js': 'stub-mcp-transport.js',
  postgres: 'stub-postgres.js',
  mysql2: 'stub-mysql2.js',
  'mysql2/promise': 'stub-mysql2-promise.js',
  '@aws-sdk/client-rds-data': 'stub-rds-data.js',
}

function writeDevOnlyStubs(out: string): void {
  for (const module of STUBBED_MODULES) {
    writeFileSync(
      resolve(out, STUB_FILES[module.specifier]),
      renderDevOnlyStub(module, UNAVAILABLE_ON_WORKERS[module.kind]),
    )
  }
}

/**
 * A package-name alias does not cover subpaths and wrangler cannot match a
 * prefix, so every stubbed specifier needs its own entry (an SDK subpath added
 * upstream needs a new `DEV_ONLY_MODULES` entry). `mcpPlugin` drops only the App
 * MCP transport's alias (RFC 0016 §7; the adapter is workerd-compatible). Stub
 * *files* are written unconditionally, so a config still pointing at one keeps finding it.
 */
function devOnlyAliases(outRelative: string, mcpPlugin: boolean): Record<string, string> {
  const stubbed = [...stubbableDevOnlyModules({ mcpPlugin }), ...SQL_CLIENT_MODULES]

  return Object.fromEntries(
    stubbed.map((module) => [
      module.specifier,
      `./${outRelative}/${STUB_FILES[module.specifier]}`,
    ]),
  )
}

/**
 * Fail rather than deploy an app declaring `@guren/plugin-mcp` while its committed
 * `wrangler.jsonc` aliases the App MCP transport to a stub *this build generated*:
 * the endpoint stays compiled shut with every gate green. The *value* decides
 * (another target is a deliberate override), matched on the last path segment of
 * either separator against `STUB_FILES`; `parseJsonc` keeps comments from matching.
 */
function assertMcpTransportNotAliased(root: string, mcpPlugin: boolean): void {
  if (!mcpPlugin) {
    return
  }

  const configPath = resolve(root, 'wrangler.jsonc')
  const config = readWranglerConfig(configPath)
  const alias = config?.alias
  if (!isRecord(alias)) {
    return
  }

  const target = alias[MCP_TRANSPORT_SPECIFIER]
  if (typeof target !== 'string' || target.split(/[\\/]/).pop() !== STUB_FILES[MCP_TRANSPORT_SPECIFIER]) {
    return
  }

  throw new Error(
    `Cloudflare build: ${configPath} aliases the App MCP transport to a stub, but this app depends on ${MCP_PLUGIN_PACKAGE} — the endpoint would deploy compiled shut. Delete this one line from "alias":\n`
    + `  ${JSON.stringify(MCP_TRANSPORT_SPECIFIER)}: ${JSON.stringify(target)}\n`
    + `Leave every other alias entry in place; ${JSON.stringify('@modelcontextprotocol/sdk/server/mcp.js')} in particular must stay stubbed — that is the dev-only MCP server, which generates files on disk.`,
  )
}

/**
 * Wrangler's `migrations_dir` only discovers flat `*.sql` files, but drizzle-kit
 * (1.x) emits one `<timestamp>_<name>/migration.sql` folder per migration.
 * Flatten each folder into `<folder-name>.sql` (plain `*.sql` files pass
 * through, `meta/` is skipped) so `wrangler d1 migrations apply` sees them in
 * filename order. Regenerated on every build — run `cloudflare:build` after adding one.
 */
export function flattenD1Migrations(migrationsDir: string, outDir: string): void {
  if (!existsSync(migrationsDir)) {
    return
  }

  const entries = readdirSync(migrationsDir, { withFileTypes: true })
  const copies: Array<{ from: string; to: string }> = []

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.sql')) {
      copies.push({ from: resolve(migrationsDir, entry.name), to: entry.name })
      continue
    }
    if (entry.isDirectory() && entry.name !== 'meta') {
      const nested = resolve(migrationsDir, entry.name, 'migration.sql')
      if (existsSync(nested)) {
        copies.push({ from: nested, to: `${entry.name}.sql` })
      }
    }
  }

  const seen = new Map<string, string>()
  for (const copy of copies) {
    const clash = seen.get(copy.to)
    if (clash) {
      throw new Error(
        `Cloudflare build: migrations "${clash}" and "${copy.from}" both flatten to "${copy.to}". Rename one so wrangler sees a stable order.`,
      )
    }
    seen.set(copy.to, copy.from)
  }

  // Rebuilt from scratch: a migration deleted or renamed upstream must not
  // linger here, because wrangler would still discover and apply it.
  if (existsSync(outDir)) {
    rmSync(outDir, { recursive: true, force: true })
  }

  if (copies.length === 0) {
    return
  }

  mkdirSync(outDir, { recursive: true })
  for (const copy of copies) {
    cpSync(copy.from, resolve(outDir, copy.to))
  }
}

/**
 * Neutralize the document types staged under `assets/` with a `_headers` file:
 * Static Assets answer before the worker runs, so `guardStaticDocument` never
 * sees one and an SVG would render inline, script and all, on the app's origin.
 * One splat per pattern: /*.svg matches at any depth, and a second splat is a
 * parse error the platform reports by *dropping the rule*.
 */
function renderAssetHeaders(assetsOut: string): string {
  const headerLines = Object.entries(DOCUMENT_ASSET_HEADERS).map(([name, value]) => `  ${name}: ${value}`)
  const patterns = [
    ...DOCUMENT_ASSET_EXTENSIONS.map((extension) => `/*.${extension}`),
    ...oddlyCasedDocumentPaths(assetsOut),
  ]

  return [
    '# Generated by `guren cloudflare:build`. Do not edit — regenerate instead.',
    ...patterns.flatMap((pattern) => ['', pattern, ...headerLines]),
    '',
  ].join('\n')
}

/**
 * Staged document files whose extension is not already lowercase, as exact
 * patterns: the one hole the `/*.<ext>` globs cannot reach. `getMimeType`
 * lowercases before its lookup while Cloudflare compiles a `_headers` pattern
 * case-sensitively (measured), and `.svg` alone has eight spellings at one splat
 * per rule. Exact rules are complete: the asset set is closed at build time.
 */
function oddlyCasedDocumentPaths(assetsOut: string): string[] {
  const documents = new Set<string>(DOCUMENT_ASSET_EXTENSIONS)
  const paths: string[] = []

  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(resolve(dir, entry.name), `${prefix}/${entry.name}`)
        continue
      }

      const dot = entry.name.lastIndexOf('.')
      const extension = dot === -1 ? '' : entry.name.slice(dot + 1)
      if (extension && extension !== extension.toLowerCase() && documents.has(extension.toLowerCase())) {
        paths.push(`${prefix}/${entry.name}`)
      }
    }
  }

  walk(assetsOut, '')

  return paths.sort()
}

/**
 * An app may ship its own `_headers` under `public/`, already copied here by
 * `stageStaticAssets`. Prepend rather than append: only the *first* rule naming
 * a header sets it and a later one appends, so going second would turn an app's
 * own `Content-Disposition` into "inline, attachment". The cost, warned about
 * rather than resolved: these rules push the app's own toward the 100-rule cap.
 */
function writeAssetHeaders(assetsOut: string): void {
  const headersFile = resolve(assetsOut, '_headers')

  // The read is the existence test: a wrong "absent" from a separate `existsSync`
  // would silently overwrite the app's own rules. `readFileSync` reports absence
  // itself, as ENOENT.
  let existing = ''
  try {
    existing = readFileSync(headersFile, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  const generated = renderAssetHeaders(assetsOut)
  const merged = existing ? `${generated}\n${existing}` : generated

  warnHeaderRuleBudget(merged, existing)
  writeFileSync(headersFile, merged)
}

/** What the platform parses before it stops. */
const HEADER_RULE_LIMIT = 100

/**
 * Say so when the rules added here push an app's own past what the platform
 * reads: Cloudflare parses at most 100 rules and *stops* at the hundredth
 * silently, so going first — which the set-versus-append reasoning above
 * requires — drops the app's last rules. Counted, not resolved: app rules first
 * would let its `Content-Disposition` turn ours into "inline, attachment".
 */
function warnHeaderRuleBudget(merged: string, existing: string): void {
  if (!existing) {
    return
  }

  const rules = merged.split('\n').filter((line) => line.startsWith('/')).length
  if (rules <= HEADER_RULE_LIMIT) {
    return
  }

  console.warn(
    `Cloudflare build: the merged _headers has ${rules} rules and the platform reads only ${HEADER_RULE_LIMIT}, `
    + `so the last ${rules - HEADER_RULE_LIMIT} of your app's own rules are dropped without an error. `
    + 'The generated document rules are placed first deliberately — the platform lets a later rule only append to a '
    + "header an earlier one set, so going second would turn your own Content-Disposition into \"inline, attachment\". "
    + 'Trim public/_headers to fit.',
  )
}

function readPackageJson(root: string): PackageJsonLike {
  const packageJsonPath = resolve(root, 'package.json')
  if (!existsSync(packageJsonPath)) {
    return {}
  }

  try {
    return JSON.parse(readFileSync(packageJsonPath, 'utf8')) as PackageJsonLike
  } catch {
    return {}
  }
}

function runAppBuild(root: string, scripts: Record<string, string>): void {
  if (!scripts.build) {
    throw new Error(
      'Cloudflare build: no "build" script found in package.json. Add one (codegen + vite build + vite build --ssr) or pass --skip-app-build after building manually.',
    )
  }

  const result = Bun.spawnSync({
    cmd: ['bun', 'run', 'build'],
    cwd: root,
    stdout: 'inherit',
    stderr: 'inherit',
  })

  if (result.exitCode !== 0) {
    throw new Error('Cloudflare build: the app "build" script failed.')
  }
}

interface SsrImport {
  /** Absolute path of the built SSR entry chunk. */
  file: string
  /** Export name the chunk exposes the renderer under; the worker names it directly. */
  rendererExport: 'render' | 'default'
}

async function resolveSsrImport(ssrDir: string, ssrEntryKey: string): Promise<SsrImport | undefined> {
  const file = resolveSsrEntryFile(ssrDir, ssrEntryKey, 'Cloudflare build')
  if (!file) {
    console.warn(
      `Cloudflare build: no SSR manifest entry for "${ssrEntryKey}" under ${ssrDir}; generating a CSR-only worker.`,
    )
    return undefined
  }

  const module = (await import(pathToFileURL(file).href)) as Record<string, unknown>
  // Mirrors extractSsrRenderer in @guren/server (mvc/inertia/InertiaEngine.ts):
  // same order, same per-candidate function test. A copy rather than an import,
  // so build.ts keeps depending on node builtins alone.
  const rendererExport = (['render', 'default'] as const).find(
    (name) => typeof module[name] === 'function',
  )
  if (!rendererExport) {
    throw new Error(
      `Cloudflare build: SSR entry ${file} does not export a renderer (expected a named "render" or default export).`,
    )
  }

  return { file, rendererExport }
}

/**
 * Statements assigning the build-derived environment, emitted as their own module
 * because worker.js imports it *first*, the only ordering ESM import hoisting
 * cannot defeat. A statement in the worker body runs after the app's module graph
 * evaluated, so a module-scope `viteAsset()` call would see no manifest and throw
 * before the worker could start.
 */
function renderWorkerEnvModule(input: {
  assetEnv: ClientAssetEnv
  viteManifest: string | undefined
}): string | undefined {
  const lines: string[] = []

  if (input.assetEnv.entry) {
    lines.push(`process.env.GUREN_INERTIA_ENTRY = ${JSON.stringify(input.assetEnv.entry)}`)
  }
  if (input.assetEnv.styles) {
    lines.push(`process.env.GUREN_INERTIA_STYLES = ${JSON.stringify(input.assetEnv.styles)}`)
  }
  if (input.viteManifest) {
    // viteAsset() reads the client manifest at render time and Workers has no
    // filesystem, so the manifest JSON travels in the worker itself.
    lines.push(`process.env.GUREN_VITE_MANIFEST = ${JSON.stringify(input.viteManifest)}`)
  }

  if (lines.length === 0) {
    return undefined
  }

  return [
    '// Generated by `guren cloudflare:build`. Do not edit — regenerate instead.',
    ...lines,
    '',
  ].join('\n')
}

function renderWorkerModule(input: {
  out: string
  root: string
  appEntry: string
  ssrImport: SsrImport | undefined
  hasEnvModule: boolean
  mcpOAuth: boolean
  mcpPath: string
  agents: AgentExport[]
  agentBindings: readonly string[]
}): string {
  const hasAgents = input.agents.length > 0
  const lines: string[] = [
    '// Generated by `guren cloudflare:build`. Do not edit — regenerate instead.',
  ]

  if (input.hasEnvModule) {
    // Must stay the first import — see renderWorkerEnvModule.
    lines.push("import './worker-env.js'")
  }

  lines.push("import { createWorkersHandler } from '@guren/plugin-cloudflare'")

  if (hasAgents) {
    lines.push(
      `import { configureAgentRuntime } from ${JSON.stringify(AGENTS_RUNTIME_SPECIFIER)}`,
      `import { routeGuardedAgentRequest } from ${JSON.stringify(AGENTS_ROUTER_SPECIFIER)}`,
      `import agentsConfig from ${quotedImport(input.out, resolve(input.root, AGENTS_CONFIG_FILE))}`,
    )
  }

  if (input.mcpOAuth) {
    lines.push(
      `import { OAuthProvider } from ${JSON.stringify(OAUTH_PROVIDER_PACKAGE)}`,
      `import { mcpOAuthPropsToAuth, presentExternalMcpAuth } from ${JSON.stringify(MCP_OAUTH_SEAM_SPECIFIER)}`,
    )
  }

  if (input.ssrImport) {
    lines.push(
      "import { setInertiaSsrRenderer } from '@guren/core'",
      `import * as ssrModule from ${quotedImport(input.out, input.ssrImport.file)}`,
    )
  }

  lines.push(`import app from ${quotedImport(input.out, input.appEntry)}`, '')

  if (input.ssrImport) {
    lines.push(`setInertiaSsrRenderer(ssrModule.${input.ssrImport.rendererExport})`, '')
  }

  if (!input.mcpOAuth && !hasAgents) {
    lines.push('export default createWorkersHandler(app)', '')
    return lines.join('\n')
  }

  lines.push('const handler = createWorkersHandler(app)', '')

  if (hasAgents) {
    lines.push(renderAgentWiring(input.out, input.root, input.agents, input.agentBindings), '')
  }

  const entry = hasAgents ? 'agentEntry' : 'handler'
  lines.push(input.mcpOAuth ? renderOAuthWorker(input.mcpPath, entry) : `export default ${entry}`, '')

  return lines.join('\n')
}

/** An import specifier for the generated worker, relative to it and quoted. */
function quotedImport(out: string, target: string): string {
  return JSON.stringify(importSpecifier(out, target, 'Cloudflare build'))
}

/**
 * The agent half of the generated program: the boot seam, the Durable Object
 * exports, and the guarded `/agents/*` mount. The resolver returns nothing on
 * purpose — `agentsPlugin`'s own boot publishes the runtime, and returning it
 * here would make the generated worker read its own latch back (RFC 0017 §6).
 */
function renderAgentWiring(
  out: string,
  root: string,
  agents: AgentExport[],
  bindings: readonly string[],
): string {
  const exports = agents
    .map((agent) => `export { ${agent.export} } from ${quotedImport(out, resolve(root, agent.module))}`)
    .join('\n')

  return `// An alarm can wake an agent before any request has booted the app, so the
// runtime latch is handed the boot rather than a runtime.
configureAgentRuntime((env) => handler.boot(env))

${exports}

// The Durable Object bindings wrangler.jsonc gives the registered agents. The
// SDK's router would otherwise reach every Durable Object in env.
const agentBindings = ${JSON.stringify(bindings)}

const agentEntry = {
  async fetch(request, env, ctx) {
    // Booted before routing, so an authorizer may read getWorkersEnv().
    await handler.boot(env)
    // /agents/* is deny-all until config/agents.ts declares routing.authorize.
    const routed = await routeGuardedAgentRequest(request, env, agentsConfig.routing, agentBindings)
    if (routed) return routed
    return handler.fetch(request, env, ctx)
  },
}`
}

/**
 * wrangler resolves its config as `wrangler.json` ?? `wrangler.jsonc` ??
 * `wrangler.toml`, first match winning silently (workers-sdk config-helpers.ts).
 * This plugin manages `wrangler.jsonc`, so a `wrangler.json` outranks everything
 * it scaffolds or checks, and scaffolding beside a lone `wrangler.toml` stops
 * wrangler reading the user's config. Name the migration before the app build runs.
 */
function assertWranglerJsoncIsAuthoritative(root: string): void {
  if (wranglerConfigExists(resolve(root, 'wrangler.json'))) {
    throw new Error(
      'Cloudflare build: found wrangler.json. wrangler reads it before the wrangler.jsonc this plugin manages, so the build-owned keys would never reach a deploy. Rename it to wrangler.jsonc — every JSON file is already valid JSONC.',
    )
  }

  if (!wranglerConfigExists(resolve(root, 'wrangler.toml'))) {
    return
  }

  if (wranglerConfigExists(resolve(root, 'wrangler.jsonc'))) {
    console.warn(
      'Cloudflare build: wrangler.toml is dead weight — wrangler reads wrangler.jsonc first. Port anything still missing into wrangler.jsonc, then delete wrangler.toml so edits to it stop looking like configuration.',
    )
    return
  }

  throw new Error(
    'Cloudflare build: found wrangler.toml, but this plugin manages wrangler.jsonc — it cannot read TOML to check the build-owned keys, and scaffolding wrangler.jsonc beside it would make wrangler silently ignore wrangler.toml. Move wrangler.toml aside, rerun the build to scaffold a reference wrangler.jsonc, then port your settings into it.',
  )
}

/**
 * `existsSync` folds an unreadable entry into "absent", and absent is the
 * branch that scaffolds a config file beside it — only ENOENT may mean no.
 */
function wranglerConfigExists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
}

/**
 * Serve a staged `.html` file at its own path and nowhere else. The platform
 * default, `auto-trailing-slash`, serves `public/page.html` at `/page` and
 * *redirects* `/page.html` there (measured), which lands the /*.html `_headers`
 * rule only on the redirect and lets a file under `public/` shadow the app's
 * route of that name, since assets answer first. A miss falls through to the worker.
 */
const HTML_HANDLING = 'none'

/**
 * The OAuth-fronted export: the module's one handler threaded through both
 * halves of the provider. The grant travels through the seam, not a header:
 * `ctx.props` is what the provider decrypted from the access token it validated.
 * @param defaultEntry What unprotected paths reach — the agent-routing entry
 *   when this app hosts agents, so `/agents/*` stays mounted and guarded.
 */
function renderOAuthWorker(mcpPath: string, defaultEntry: string): string {
  // A template literal rather than a line array, so a reviewer can read the
  // generated program as one.
  return `export default new OAuthProvider({
  apiRoute: ${JSON.stringify(mcpPath)},
  apiHandler: {
    fetch(request, env, ctx) {
      // ctx.props is the grant the provider decrypted from the access
      // token it has already validated. A shape the endpoint cannot read
      // is refused here, never forwarded as a partial principal.
      const auth = mcpOAuthPropsToAuth(ctx.props)
      if (!auth) {
        return new Response(
          JSON.stringify({
            error: 'unauthorized',
            message: 'This access token carries no readable grant. Re-authorize the client.',
          }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        )
      }
      // The seam is keyed on this exact Request object — dispatch the one
      // presentExternalMcpAuth returns, never a copy of it.
      return handler.fetch(presentExternalMcpAuth(request, auth), env, ctx)
    },
  },
  defaultHandler: ${defaultEntry},
  authorizeEndpoint: ${JSON.stringify(OAUTH_ENDPOINTS.authorize)},
  tokenEndpoint: ${JSON.stringify(OAUTH_ENDPOINTS.token)},
  // Dynamic client registration (RFC 7591). Deprecated in the MCP
  // 2026-07-28 line in favour of Client ID Metadata Documents, but it is
  // what shipping MCP SDK 1.x clients use to register themselves today.
  clientRegistrationEndpoint: ${JSON.stringify(OAUTH_ENDPOINTS.register)},
})`
}

function scaffoldWranglerConfig(
  root: string,
  out: string,
  packageName: string | undefined,
  mcpPlugin: boolean,
  mcpOAuth: boolean,
  agents: AgentExport[],
): void {
  const configPath = resolve(root, 'wrangler.jsonc')
  const appName = (packageName ?? 'guren-app').replace(/^@[^/]+\//, '')
  const outRelative = relative(root, out).split(sep).join('/')

  const config = {
    name: appName,
    main: `${outRelative}/worker.js`,
    compatibility_date: new Date().toISOString().slice(0, 10),
    compatibility_flags: ['nodejs_compat'],
    alias: devOnlyAliases(outRelative, mcpPlugin),
    define: {
      // Framework and app code branch on NODE_ENV at module scope, statements in
      // the generated worker cannot beat ESM import hoisting, and wrangler `vars`
      // are not guaranteed to reach `process.env` before the module graph
      // evaluates — so it is substituted at build time.
      'process.env.NODE_ENV': '"production"',
      // workerd leaves `import.meta.url` undefined, which kills Vite's SSR
      // `createRequire(import.meta.url)` and scaffolded `new URL(..., import.meta.url)`
      // at module scope. A literal is safe because Workers has no filesystem, so
      // every such path is meaningless there anyway.
      'import.meta.url': '"file:///worker.js"',
    },
    assets: { directory: `${outRelative}/assets`, html_handling: HTML_HANDLING },
    d1_databases: [
      {
        binding: 'DB',
        database_name: appName,
        database_id: 'TODO: wrangler d1 create',
        migrations_dir: `${outRelative}/d1-migrations`,
      },
    ],
    // Build-owned only while --mcp-oauth is on: an app that never fronts the
    // MCP endpoint with OAuth has nothing to store in this namespace, and a
    // binding scaffolded "just in case" is a namespace someone has to create
    // before the config validates.
    ...(mcpOAuth ? { kv_namespaces: [oauthKvNamespace()] } : {}),
    // The legacy `migrations` list rather than the declarative `exports` map:
    // both are accepted by the verifier and by wrangler, and this is the form
    // the agents SDK documents and the workerd test lane runs.
    ...(agents.length > 0
      ? {
          durable_objects: {
            bindings: agents.map((agent) => ({
              name: durableObjectBindingName(agent.export),
              class_name: agent.export,
            })),
          },
          migrations: [{ tag: 'v1', new_sqlite_classes: agents.map((agent) => agent.export) }],
        }
      : {}),
    vars: { NODE_ENV: 'production' },
  }

  try {
    // `wx` is the exists-check and the write in one atomic operation; an
    // existing config is never overwritten.
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      warnMissingBuildOwnedKeys(configPath, outRelative, mcpPlugin, mcpOAuth)
      return
    }
    throw error
  }
  const notes = ['fill in d1_databases[0].database_id']
  if (mcpOAuth) {
    notes.push(`create the ${OAUTH_KV_BINDING} namespace (wrangler kv namespace create ${OAUTH_KV_BINDING}) and fill in its id`)
  }
  console.log(`Cloudflare build: scaffolded ${configPath} — ${notes.join(', and ')} before deploying.`)
}

/**
 * The consent flow, written once into the app and never overwritten, on the same
 * contract as `wrangler.jsonc`: these are the developer's files from the moment
 * they exist. Only reached with `--mcp-oauth` on.
 */
function scaffoldConsentFlow(root: string): void {
  const written: string[] = []

  for (const path of MCP_OAUTH_TEMPLATE_FILES) {
    const target = resolve(root, ...path.split('/'))
    mkdirSync(resolve(target, '..'), { recursive: true })
    try {
      writeFileSync(target, loadMcpOAuthTemplate(path), { flag: 'wx' })
      written.push(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
    }
  }

  if (written.length === 0) {
    return
  }

  console.log(
    `Cloudflare build: scaffolded the OAuth consent flow — ${written.join(', ')}.`,
  )

  if (written.includes(MCP_OAUTH_ROUTES_FILE)) {
    // Said only on the build that created the file, the one moment nothing can
    // have wired it yet. Answering it later would mean a second implementation of
    // `@guren/cli`'s route-registrar rule, which would drift from `guren check`.
    console.log(
      `  Nothing mounts ${MCP_OAUTH_ROUTES_FILE} yet. Add these two lines to your routes entry (routes/web.ts):\n`
      + `    import { ${MCP_OAUTH_REGISTRAR} } from './mcp-oauth'\n`
      + `    ${MCP_OAUTH_REGISTRAR}(router)   // inside your registrar, with its router parameter`,
    )
  }
}

/**
 * The committed config, parsed — `undefined` when it is absent or malformed.
 * Callers that must tell those apart check `existsSync` first; the rest treat
 * both as nothing to read.
 */
function readWranglerConfig(configPath: string): Record<string, unknown> | undefined {
  try {
    return parseJsonc(readFileSync(configPath, 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/**
 * `wrangler.jsonc` carries comments in any app that has edited it, and
 * `JSON.parse` rejects the first one. Only comments and trailing commas are
 * stripped, the whole of what wrangler accepts beyond JSON. The scan tracks
 * string literals rather than pattern-matching, because `define` holds
 * `"\"file:///worker.js\""` — a `//` inside a string, with escaped quotes around it.
 */
function parseJsonc(text: string): unknown {
  const out: string[] = []
  let index = 0

  while (index < text.length) {
    const char = text[index]

    if (char === '"') {
      const start = index
      index += 1
      while (index < text.length) {
        if (text[index] === '\\') {
          index += 2
          continue
        }
        if (text[index] === '"') {
          index += 1
          break
        }
        index += 1
      }
      out.push(text.slice(start, index))
      continue
    }

    if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') {
        index += 1
      }
      continue
    }

    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2)
      index = end === -1 ? text.length : end + 2
      continue
    }

    if (char === '}' || char === ']') {
      // Every chunk is one character except a string literal, emitted whole and
      // never blank or a bare comma — so a comma as the last non-blank chunk is
      // a trailing one, not a comma inside a value.
      let back = out.length - 1
      while (back >= 0 && /^\s+$/.test(out[back])) {
        back -= 1
      }
      if (back >= 0 && out[back] === ',') {
        out.splice(back, 1)
      }
    }

    out.push(char)
    index += 1
  }

  return JSON.parse(out.join(''))
}

/**
 * The scaffold never overwrites an existing config, but `alias`, `define` and
 * `migrations_dir` are build-owned invariants pointing into the output directory:
 * an app scaffolded before they existed deploys a worker that cannot resolve
 * `bun:sqlite` or never applies its migrations. Named per entry, never as a whole
 * `"alias"`/`"define"` object, which reads as one to paste over the app's own entries.
 */
function warnMissingBuildOwnedKeys(
  configPath: string,
  outRelative: string,
  mcpPlugin: boolean,
  mcpOAuth: boolean,
): void {
  const config = readWranglerConfig(configPath)
  if (!config) {
    // Past the comment and trailing-comma stripping, so the file is malformed by
    // wrangler's reckoning too; passing silently leaves the keys below unchecked.
    console.warn(
      `Cloudflare build: could not parse ${configPath}, so its build-owned keys went unchecked. Fix the file, or compare it against a config scaffolded in an empty directory.`,
    )
    return
  }

  const missing: string[] = []
  // A non-object `alias` is malformed rather than outdated, and `in` would throw
  // out of a function whose point is to warn. Treat it as holding no entries.
  const alias = isRecord(config.alias) ? config.alias : {}
  for (const [specifier, target] of Object.entries(devOnlyAliases(outRelative, mcpPlugin))) {
    if (!(specifier in alias)) {
      missing.push(`${JSON.stringify(specifier)}: ${JSON.stringify(target)} (inside "alias")`)
    }
  }
  const define = config.define as Record<string, string> | undefined
  if (!define?.['process.env.NODE_ENV']) {
    missing.push('"process.env.NODE_ENV": "\\"production\\"" (inside "define")')
  }
  const d1 = (config.d1_databases as Array<Record<string, unknown>> | undefined)?.[0]
  if (d1 && d1.migrations_dir !== `${outRelative}/d1-migrations`) {
    missing.push(`"migrations_dir": "${outRelative}/d1-migrations" (inside d1_databases[0])`)
  }

  if (missing.length > 0) {
    console.warn(
      `Cloudflare build: ${configPath} predates this plugin version. Add these entries, alongside whatever the file already has under the same keys, or the worker will fail to start or skip migrations:\n  ${missing.join('\n  ')}`,
    )
  }

  warnMissingHtmlHandling(configPath, config)
  warnOAuthDrift(configPath, config, mcpOAuth)
}

/**
 * Kept out of `warnMissingBuildOwnedKeys`: that list's shared sentence ends "the
 * worker will fail to start or skip migrations", which is not true here — adding
 * this key *changes* how the app's own HTML is served, and needs saying. Warned
 * only when the key is absent: any other value is a decision an app typed, and a
 * config with no `assets` serves no static files for `_headers` to protect.
 */
function warnMissingHtmlHandling(configPath: string, config: Record<string, unknown>): void {
  const assets = config.assets as Record<string, unknown> | undefined

  if (!assets || assets.html_handling !== undefined) {
    return
  }

  console.warn(
    `Cloudflare build: ${configPath} does not set "html_handling" under "assets", so a document staged from public/ is still served at its extensionless path — where the /*.html rule in _headers does not reach it, and where it shadows any route of that name in your app. Add "html_handling": "${HTML_HANDLING}" to close both. Note this changes how those files are served: public/about.html stops answering at /about.`,
  )
}

/**
 * The drift `--mcp-oauth` leaves detectable in the other direction: a config
 * scaffolded *with* the flag (carrying `OAUTH_KV`) while today's build omitted
 * it, so the replacing worker has no `OAuthProvider`, `/oauth/token` answers 404
 * and every authorized client stops working with no build output mentioning
 * OAuth. A warning: a non-OAuth worker from the same repository is legitimate.
 */
function warnOAuthDrift(
  configPath: string,
  config: Record<string, unknown>,
  mcpOAuth: boolean,
): void {
  if (mcpOAuth || !oauthKvBinding(config)) {
    return
  }

  console.warn(
    `Cloudflare build: ${configPath} binds ${OAUTH_KV_BINDING}, which only an OAuth-fronted worker uses, but this build ran without --mcp-oauth. The worker it produced has no OAuth provider in it: ${OAUTH_ENDPOINTS.token} and ${OAUTH_ENDPOINTS.register} will 404 and already-authorized clients will stop working. Pass --mcp-oauth, or remove the binding if this app no longer fronts its MCP endpoint with OAuth.`,
  )
}

