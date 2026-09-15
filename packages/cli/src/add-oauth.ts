import { consola } from 'consola'
import { CliError } from './cli-error'
import { fileExists, readIfExists } from './discovery'
import { generateSchemaMigration } from './make-migration'
import { appendOAuthStateTable } from './oauth-state-table'
import { resolveAppEntry, wireProviders } from './provider-registrar'
import { wireRouteRegistrar } from './route-registrar'
import { schemaPathFor } from './schema-parser'
import { scaffoldTemplateFile } from './scaffold-templates'
import { writeScaffoldFiles, type WriterOptions } from './utils'

/**
 * `guren add oauth`: the OAuth provider, controller and routes, over an
 * `oauth_states` table and its migration. Core's `OAuthServiceProvider` is not
 * wired, since its manager keeps state in process memory.
 */
export async function addOAuth(options: WriterOptions = {}): Promise<string[]> {
  const schemaFile = schemaPathFor(null)
  if (!(await fileExists(process.cwd(), schemaFile))) {
    throw new CliError(
      `guren add oauth keeps OAuth state in an oauth_states table in ${schemaFile}, but this app has no `
      + `${schemaFile}. Nothing was scaffolded.`,
    )
  }

  const created = await writeScaffoldFiles([
    scaffoldTemplateFile('oauth', 'app/Providers/OAuthProvider.ts'),
    scaffoldTemplateFile('oauth', 'app/Http/Controllers/Auth/OAuthController.ts'),
    scaffoldTemplateFile('oauth', 'routes/oauth.ts'),
  ], options)

  const tableAppended = await appendOAuthStateTable()

  await wireProviders([{ name: 'OAuthProvider' }])
  await wireRouteRegistrar('registerOAuthRoutes', "import registerOAuthRoutes from './oauth.js'")

  const migrationPending = tableAppended
    && !(await generateSchemaMigration('create_oauth_states_table', 'oauth_states'))

  const appEntry = await resolveAppEntry()
  const staleCoreProvider = appEntry !== null
    && ((await readIfExists(process.cwd(), appEntry)) ?? '').includes('CoreOAuthServiceProvider')

  consola.info('Next steps:')
  if (migrationPending) {
    consola.info('  • Generate the migration: bun run db:make')
  }
  consola.info('  • Run the migration: bun run db:migrate')
  consola.info('  • Set OAUTH_<PROVIDER>_CLIENT_ID / _CLIENT_SECRET / _REDIRECT_URI in .env for each provider you enable')
  if (staleCoreProvider) {
    consola.info(`  • Remove CoreOAuthServiceProvider from ${appEntry}: an earlier scaffold wired it, and OAuthProvider now binds the manager`)
  }

  return created
}
