/**
 * The `--chat` half of `guren make:ai-agent` (RFC 0029 §8, Part 4): a page, controller and routes
 * that stream the agent through `useChat`, with the history restored on reload. The chat component
 * is copied into the app like `guren add ui`'s, so the AI SDK's React line is the app's to follow.
 */
import { resolve } from 'node:path'
import { configuresConversations } from './add-ai'
import { assertNotApiOnly } from './app-surface'
import { CliError } from './cli-error'
import { appDependsOn, readIfExists } from './discovery'
import { ensureUiComponents, uiComponentsImportedBy } from './guren-css'
import { buildControllerSource } from './make-controller'
import { buildRoutesSource, routeCall } from './make-route'
import { DEFAULT_ROUTES_FILE, wireRouteRegistrar } from './route-registrar'
import { scaffoldTemplateFile } from './scaffold-templates'
import { importSpecifier, pagesAccessor, writeScaffoldFiles, type ScaffoldFileEntry } from './utils'

const AGENT_CHAT_COMPONENT_PATH = 'resources/js/components/ai/AgentChat.tsx'
const AI_SDK_REACT_PACKAGE = '@ai-sdk/react'

const AUTH_MIDDLEWARE = "requireAuthenticated({ redirectTo: '/login' })"

interface AgentChatFiles {
  controller: string
  routes: string
  page: string
  registrar: string
}

/** Where `--chat` writes for an agent, from its class and kebab-case names. */
function agentChatFiles(className: string, slug: string): AgentChatFiles {
  return {
    controller: `app/Http/Controllers/${className}ChatController.ts`,
    routes: `routes/${slug}-chat.ts`,
    page: `resources/js/pages/${slug}/Chat.tsx`,
    registrar: `register${className}ChatRoutes`,
  }
}

/** Refusals that hold before any file is written, the agent's included. */
export async function assertChatPossible(cwd: string, options: { output?: boolean; root?: string }): Promise<void> {
  if (options.output) {
    throw new CliError('--chat streams the agent, and an agent with --output cannot stream: its JSON would reach the chat as text.')
  }
  if (options.root) {
    throw new CliError('--chat writes the routes into routes/web.ts, which a module does not mount. Drop --module, or write the chat by hand.')
  }
  await assertNotApiOnly(cwd, {
    does: 'make:ai-agent --chat writes an Inertia page for the chat',
    instead: 'An API-only app can return stream() from a controller and render the chat in its own client',
  })
}

/** The per-agent files, written in the agent's own batch so an existing one refuses before any write. */
export function agentChatEntries(className: string, slug: string, agentPath: string): ScaffoldFileEntry[] {
  const paths = agentChatFiles(className, slug)
  return [
    { path: paths.controller, contents: chatControllerTemplate(className, slug, importSpecifier(paths.controller, agentPath)) },
    { path: paths.routes, contents: chatRoutesTemplate(className, slug, paths) },
    { path: paths.page, contents: chatPageTemplate(className, slug) },
  ].map((entry) => ({ ...entry, flag: '--chat' }))
}

/** After the batch: the shared component and the UI components it imports, then the routes wiring. */
export async function finishAgentChat(
  cwd: string,
  input: { className: string; slug: string; force?: boolean },
): Promise<{ files: string[]; notes: string[] }> {
  // Shared by every agent's chat page, so an existing copy, edited or not, is the app's unless --force.
  const component = scaffoldTemplateFile('ai-chat', AGENT_CHAT_COMPONENT_PATH)
  const files = await writeScaffoldFiles([component], { cwd, skipExisting: true, force: Boolean(input.force) })
  // Announces its own writes, as for make:feature's pages.
  await ensureUiComponents(cwd, uiComponentsImportedBy([component]))

  const { registrar, routes } = agentChatFiles(input.className, input.slug)
  const routesFile = resolve(cwd) === process.cwd() ? DEFAULT_ROUTES_FILE : resolve(cwd, DEFAULT_ROUTES_FILE)
  await wireRouteRegistrar(registrar, `import { ${registrar} } from '${importSpecifier(DEFAULT_ROUTES_FILE, routes)}'`, routesFile)

  return { files, notes: await chatNotes(cwd) }
}

async function chatNotes(cwd: string): Promise<string[]> {
  const notes: string[] = []
  if ((await appDependsOn(cwd, AI_SDK_REACT_PACKAGE)) === false) {
    notes.push(`The chat page uses useChat() from ${AI_SDK_REACT_PACKAGE}, the 4.x line that pairs with ai 7. Run: bun add ${AI_SDK_REACT_PACKAGE}@^4`)
  }
  const config = await readIfExists(cwd, 'config/ai.ts')
  if (config !== null && !configuresConversations(config)) {
    notes.push('A chat keeps its history in a conversation store, and config/ai.ts configures none. Set `conversations` there (guren add ai writes one unless --no-conversations).')
  }
  return notes
}

function chatControllerTemplate(className: string, slug: string, agentImport: string): string {
  return buildControllerSource({
    className: `${className}ChatController`,
    imports: [
      "import { ChatTurnSchema } from '@guren/plugin-ai'",
      "import { z } from 'zod'",
      "import { pages } from '@/.guren/pages.gen'",
      `import { ${className} } from '${agentImport}'`,
    ],
    declarations: ['const ChatPageQuerySchema = z.object({ conversation: z.string().optional() })'],
    actions: [
      {
        name: 'show',
        comment: ['The chat page. `?conversation=` reopens one; an empty or unreadable id opens an empty chat.'],
        body: `    const { conversation } = this.validateQuery(ChatPageQuerySchema)
    const user = await this.auth.userOrFail<{ id: string | number }>()
    const messages = conversation ? await this.make('ai').agent(${className}).as(user).history(conversation) : null

    return this.inertia(${pagesAccessor(slug, 'Chat')}, {
      conversationId: messages ? (conversation ?? null) : null,
      messages: messages ?? [],
    })`,
      },
      {
        name: 'chat',
        comment: ['One turn: the server replays the stored history, so the client sends only its new message.'],
        body: `    const { conversation, message } = await this.validateBody(ChatTurnSchema)
    const user = await this.auth.userOrFail<{ id: string | number }>()

    return this.make('ai')
      .agent(${className})
      .as(user)
      .stream(message, { conversation: conversation ?? true, signal: this.request.raw.signal })`,
      },
    ],
  })
}

// Under `/<slug>/chat` and named `<slug>.chat` / `<slug>.send`, apart from the names and paths a resource uses.
function chatRoutesTemplate(className: string, slug: string, paths: AgentChatFiles): string {
  const controller = `${className}ChatController`
  const show = routeCall('router', 'get', `/${slug}/chat`, `[${controller}, 'show']`, {
    contract: `{ name: '${slug}.chat', middlewares: [${AUTH_MIDDLEWARE}] }`,
  })
  const send = routeCall('router', 'post', `/${slug}/chat`, `[${controller}, 'chat']`, {
    contract: `{ name: '${slug}.send', body: ChatTurnSchema, middlewares: [${AUTH_MIDDLEWARE}] }`,
  })
  return buildRoutesSource({
    coreImports: ['requireAuthenticated'],
    imports: ["import { ChatTurnSchema } from '@guren/plugin-ai'", `import ${controller} from '${importSpecifier(paths.routes, paths.controller)}'`],
    registrar: paths.registrar,
    body: [show, send],
  })
}

function chatPageTemplate(className: string, slug: string): string {
  const title = className.replace(/(?<=[a-z0-9])(?=[A-Z])/gu, ' ')
  return `import { Head } from '@inertiajs/react'
import type { UIMessage } from '@guren/plugin-ai/client'
import { route } from '@/.guren/routes.gen'
import { AgentChat } from '@/resources/js/components/ai/AgentChat'

interface Props {
  conversationId: string | null
  messages: UIMessage[]
}

export default function ${className}Chat({ conversationId, messages }: Props) {
  return (
    <main className="min-h-screen bg-g-page font-sans text-g-text">
      <Head title="${title}" />
      <div className="mx-auto max-w-3xl space-y-6 px-6 py-12">
        <h1 className="flex items-center gap-3 text-3xl font-bold text-g-heading">
          <span aria-hidden className="h-7 w-[3px] shrink-0 rounded-full bg-[image:var(--g-tick)]" />
          ${title}
        </h1>
        <AgentChat api={route('${slug}.send')} conversationId={conversationId} messages={messages} />
      </div>
    </main>
  )
}
`
}

