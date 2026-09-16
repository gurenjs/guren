import { PORTABLE_AGENT_TOOL_NAME_PATTERN } from '@guren/core'
import { AI_PLUGIN_PACKAGE } from './add-ai'
import { CliError } from './cli-error'
import { compareVersions } from './codemods'
import { appDependsOn } from './discovery'
import { detectRunner } from './make-test'
import { readInstalledVersion } from './plugin-manifest'
import { resolveAppEntry } from './provider-registrar'
import { listTools } from './tool-list'
import {
  relativeImportPath,
  resourceName,
  safeModuleName,
  splitCommaList,
  writeScaffoldFile,
  type WriterOptions,
} from './utils'

/** The `@guren/testing` release that ships `TestApp.fakeAi()`, which `--test` writes against. */
export const FAKE_AI_TESTING_VERSION = '1.11.0'

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
  const writer: WriterOptions = { force: options.force, overwritten: options.overwritten, cwd }
  const files = [
    await writeScaffoldFile(agentPath, agentTemplate(className, fileName, tools, Boolean(options.output)), writer),
  ]

  if (options.test) {
    const testPath = `${root}tests/Ai/${className}.test.ts`
    const appEntry = (await resolveAppEntry(cwd)) ?? 'src/app.ts'
    files.push(await writeScaffoldFile(testPath, testTemplate({
      className,
      runner: await detectRunner(cwd),
      appImport: importOf(testPath, appEntry),
      agentImport: importOf(testPath, agentPath),
      output: Boolean(options.output),
    }), writer))
  }

  return { files, notes }
}

/** The generated test calls `fakeAi()`, which an app on an older `@guren/testing` does not have. */
async function testingNotes(cwd: string): Promise<string[]> {
  const upgrade = `The test uses TestApp.fakeAi(), from @guren/testing ${FAKE_AI_TESTING_VERSION}.`
  if ((await appDependsOn(cwd, '@guren/testing')) === false) {
    return [`${upgrade} Run: bun add -d @guren/testing`]
  }
  const installed = await readInstalledVersion(cwd, '@guren/testing')
  if (installed !== null && compareVersions(installed, FAKE_AI_TESTING_VERSION) < 0) {
    return [`${upgrade} This app has ${installed}. Run: bun add -d @guren/testing@^${FAKE_AI_TESTING_VERSION}`]
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
  const quoted = tools.map((tool) => `'${tool}'`)
  const imports = output
    ? `import { Agent, Output } from '${AI_PLUGIN_PACKAGE}'\nimport { z } from 'zod'`
    : `import { Agent } from '${AI_PLUGIN_PACKAGE}'`
  const schema = output
    ? `\nconst ${className}Output = z.object({\n  summary: z.string(),\n})\n`
    : ''
  const members = [
    // Pinned so a minifier renaming the class cannot change the name fakes and audit lines use.
    `  static override agentName = '${agentName}'`,
    ...(tools.length > 0 ? [`  static override scopes = [${tools.map((tool) => `'tool:${tool}'`).join(', ')}] as const`] : []),
    '',
    "  instructions = 'Describe the task, which tools to use, and what a good answer looks like.'",
    ...(output ? ['', `  output = Output.object({ schema: ${className}Output })`] : []),
    ...(tools.length > 0 ? ['', '  override tools() {', `    return this.appTools([${quoted.join(', ')}])`, '  }'] : []),
  ]
  // The type argument is what makes a name `scopes` does not grant a compile error in appTools().
  const base = tools.length > 0 ? `Agent<typeof ${className}.scopes>` : 'Agent'
  return `${imports}\n${schema}\nexport class ${className} extends ${base} {\n${members.join('\n')}\n}\n`
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
