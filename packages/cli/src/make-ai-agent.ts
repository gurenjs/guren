import { PORTABLE_AGENT_TOOL_NAME_PATTERN } from '@guren/server'
import { AI_PLUGIN_PACKAGE } from './add-ai'
import { CliError } from './cli-error'
import { appDependsOn, readIfExists } from './discovery'
import { detectRunner } from './make-test'
import { resolveAppEntry } from './provider-registrar'
import { listTools } from './tool-list'
import {
  relativeImportPath,
  resourceName,
  safeModuleName,
  splitCommaList,
  writeScaffoldFiles,
  type ScaffoldFileEntry,
  type WriterOptions,
} from './utils'

export interface MakeAiAgentOptions extends WriterOptions {
  /** Comma-separated tool names for `appTools()`, each checked against the app's derived tools. */
  tools?: string
  /** Declare an `Output.object()` with a Zod schema stub. */
  output?: boolean
  /** Also write a test that scripts the agent through `app.fakeAi()`. */
  test?: boolean
}

export interface MakeAiAgentResult {
  files: string[]
  notes: string[]
}

/**
 * `guren make:ai-agent` (RFC 0029 §8): an in-process `Agent` under `app/Ai/Agents`.
 * Not `make:agent`, which scaffolds RFC 0017's durable Workers agent.
 */
export async function makeAiAgent(name: string, options: MakeAiAgentOptions = {}): Promise<MakeAiAgentResult> {
  const { className, fileName } = resourceName(name)
  if (!className) throw new CliError('Agent name is required.')

  const cwd = options.cwd ?? process.cwd()
  const tools = options.tools === undefined ? [] : [...new Set(splitCommaList(options.tools))]
  const notes: string[] = []
  // Before any write: a name no route derives would construct an agent that throws at as().
  if (tools.length > 0) notes.push(...(await assertToolsExist(cwd, tools)))

  if ((await appDependsOn(cwd, AI_PLUGIN_PACKAGE)) === false) {
    notes.push(`${AI_PLUGIN_PACKAGE} is not in package.json yet. Run: bunx guren add ai`)
  }
  if (options.test) notes.push(...(await testingNotes(cwd)))

  const root = options.root ? `modules/${safeModuleName(options.root)}/` : ''
  const agentPath = `${root}app/Ai/Agents/${className}.ts`
  const entries: ScaffoldFileEntry[] = [
    { path: agentPath, contents: agentTemplate(className, fileName, tools, Boolean(options.output)) },
  ]

  if (options.test) {
    const testPath = `${root}tests/Ai/${className}.test.ts`
    const appEntry = (await resolveAppEntry(cwd)) ?? 'src/app.ts'
    entries.push({
      path: testPath,
      contents: testTemplate({
        className,
        runner: await detectRunner(cwd),
        appImport: importOf(testPath, appEntry),
        agentImport: importOf(testPath, agentPath),
        output: Boolean(options.output),
      }),
      flag: '--test',
    })
  }

  const files = await writeScaffoldFiles(entries, { force: options.force, overwritten: options.overwritten, cwd, subject: className })
  return { files, notes }
}

/**
 * The generated test calls `TestApp.fakeAi()`. Asked of the installed declarations, not a
 * version number: the release that first ships it is not known when this is written.
 */
async function testingNotes(cwd: string): Promise<string[]> {
  if ((await appDependsOn(cwd, '@guren/testing')) === false) {
    return ['The test uses TestApp.fakeAi() from @guren/testing. Run: bun add -d @guren/testing']
  }
  const declarations = await readIfExists(cwd, 'node_modules/@guren/testing/dist/index.d.ts')
  if (declarations !== null && !declarations.includes('fakeAi(')) {
    return ['The test uses TestApp.fakeAi(), which the installed @guren/testing predates. Run: bun add -d @guren/testing@latest']
  }
  return []
}

async function assertToolsExist(cwd: string, names: readonly string[]): Promise<string[]> {
  let available: string[]
  try {
    available = (await listTools({ appRoot: cwd })).tools.map((tool) => tool.toolName)
  } catch (error) {
    throw new CliError(
      `Could not load the app's routes to check --tools: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const unknown = names.filter((name) => !available.includes(name))
  if (unknown.length > 0) {
    throw new CliError(
      `No route derives the tool ${unknown.map((name) => `"${name}"`).join(', ')}. `
      + (available.length > 0
        ? `This app exposes: ${available.sort().join(', ')}.`
        : 'This app exposes no agent tools: declare .agent() on a named route.'),
    )
  }
  return names
    .filter((name) => !PORTABLE_AGENT_TOOL_NAME_PATTERN.test(name))
    .map((name) =>
      `The tool name "${name}" is outside [A-Za-z0-9_-]{1,64}, which Anthropic and OpenAI reject. `
      + 'Set agent.toolName on its route.')
}

function importOf(fromFile: string, target: string): string {
  return relativeImportPath(fromFile, target.replace(/\.ts$/u, '.js'))
}

function agentTemplate(className: string, agentName: string, tools: readonly string[], output: boolean): string {
  const imports = [`import { Agent${output ? ', Output' : ''} } from '${AI_PLUGIN_PACKAGE}'`]
  // Pinned so a minifier renaming the class cannot change the name fakes and audit lines use.
  const statics = [`  static override agentName = '${agentName}'`]
  const members = ["  instructions = 'Describe the task, which tools to use, and what a good answer looks like.'"]
  let schema = ''
  let base = 'Agent'

  if (output) {
    imports.push("import { z } from 'zod'")
    schema = `\nconst ${className}Output = z.object({\n  summary: z.string(),\n})\n`
    members.push('', `  output = Output.object({ schema: ${className}Output })`)
  }
  if (tools.length > 0) {
    statics.push(`  static override scopes = [${tools.map((tool) => `'tool:${tool}'`).join(', ')}] as const`)
    members.push('', '  override tools() {', `    return this.appTools([${tools.map((tool) => `'${tool}'`).join(', ')}])`, '  }')
    // The type argument is what makes a name `scopes` does not grant a compile error in appTools().
    base = `Agent<typeof ${className}.scopes>`
  }

  return `${imports.join('\n')}\n${schema}\nexport class ${className} extends ${base} {\n${[...statics, '', ...members].join('\n')}\n}\n`
}

function testTemplate(input: {
  className: string
  runner: 'bun' | 'vitest'
  appImport: string
  agentImport: string
  output: boolean
}): string {
  const { className, runner, appImport, agentImport, output } = input
  const scripted = output ? "{ output: { summary: 'A scripted summary.' } }" : "'A scripted answer.'"
  const assertion = output
    ? "expect(response.output.summary).toBe('A scripted summary.')"
    : "expect(response.text).toBe('A scripted answer.')"
  return `import { describe, expect, it } from '${runner === 'bun' ? 'bun:test' : 'vitest'}'
import { TestApp } from '@guren/testing'
import app from '${appImport}'
import { ${className} } from '${agentImport}'

describe('${className}', () => {
  it('answers with the scripted response', async () => {
    const http = await TestApp.fromApp(app)
    // Replaces the model only: appTools() still dispatches into the app's routes.
    using ai = http.fakeAi()
    ai.respond(${className}, [${scripted}])

    const response = await app.container.make('ai').agent(${className}).as({ id: 1 }).prompt('Hello')

    ${assertion}
    ai.assertPrompted(${className}, (input) => input === 'Hello')
  })
})
`
}
