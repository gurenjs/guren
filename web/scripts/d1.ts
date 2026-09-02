/**
 * The bit of wrangler the deploy scripts need: run SQL against the D1
 * database and get the rows back.
 *
 * Deliberately not shell. Each of these calls decides whether a deploy writes
 * to production, and the shell forms of that decision fail quietly: a command
 * substitution that dies under `set -e` before its own error message runs, a
 * `grep -q` that reports success because the pipe closed, a non-zero exit
 * swallowed by a pipeline. Here a failure is an exception carrying wrangler's
 * own stderr.
 *
 * Every script that uses this takes `--local`, which points the same sequence
 * at the wrangler dev database — the way to rehearse a deploy without writing
 * to production.
 */
const DATABASE = 'guren-web'

interface D1Result<TRow> {
  results?: TRow[]
  success: boolean
}

export interface D1Client {
  /** Run one statement and return its rows. Throws on anything but success. */
  query<TRow>(sql: string): Promise<TRow[]>
  /** Stream a whole SQL file into the database. */
  executeFile(path: string): Promise<void>
  /** For messages: which database this client is about to write to. */
  readonly label: string
}

/**
 * wrangler prints a banner, and sometimes an update notice, alongside its
 * JSON — so the payload is cut out rather than parsed from the whole stream.
 */
function extractJson(output: string): string {
  const start = output.indexOf('[')
  const end = output.lastIndexOf(']')
  if (start === -1 || end <= start) {
    throw new Error(`wrangler produced no JSON payload:\n${output}`)
  }
  return output.slice(start, end + 1)
}

async function wrangler(args: string[]): Promise<string> {
  const child = Bun.spawn(['bunx', 'wrangler', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  if (code !== 0) {
    throw new Error(`wrangler ${args.join(' ')} exited ${code}\n${stderr}${stdout}`)
  }
  return stdout
}

export function createD1Client(remote: boolean): D1Client {
  const target = remote ? '--remote' : '--local'

  return {
    label: `${DATABASE} (${remote ? 'remote' : 'local'})`,

    async query<TRow>(sql: string): Promise<TRow[]> {
      const output = await wrangler([
        'd1', 'execute', DATABASE, target, '--json', '--command', sql,
      ])
      const parsed = JSON.parse(extractJson(output)) as D1Result<TRow>[]
      const failed = parsed.find((result) => !result.success)
      if (failed) {
        throw new Error(`D1 refused the statement:\n${sql}\n${JSON.stringify(failed)}`)
      }
      return parsed.flatMap((result) => result.results ?? [])
    },

    async executeFile(path: string): Promise<void> {
      await wrangler(['d1', 'execute', DATABASE, target, '--file', path, '--yes'])
    },
  }
}

/** Both deploy scripts take the same flag. */
export function isRemote(argv: string[]): boolean {
  return !argv.includes('--local')
}
