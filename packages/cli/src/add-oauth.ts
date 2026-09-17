import { consola } from 'consola'
import { CliError } from './cli-error'
import { registerConsoleCommand } from './console-registrar'
import { fileExists, readIfExists } from './discovery'
import { generateSchemaMigration } from './make-migration'
import { KNOWN_OAUTH_PROVIDERS, oauthEnvEntries } from './oauth-scaffold'
import { appendOAuthStateTable } from './oauth-state-table'
import { resolveAppEntry, wireConfig, wireProviders } from './provider-registrar'
import { wireRouteRegistrar } from './route-registrar'
import { schemaPathFor } from './schema-parser'
import { definitionTemplateFile, scaffoldTemplateFile } from './scaffold-templates'
import { appendScaffoldEnv, installsConfigDefinition } from './service-scaffold'
import { writeScaffoldFiles, type WriterOptions } from './utils'

/**
 * `guren add oauth`: the OAuth provider (a `config/oauth.ts` definition in an app
 * declaring its environment), controller and routes, over an `oauth_states` table
 * and its migration. Core's `OAuthServiceProvider` is not wired, since its
 * manager keeps state in process memory.
 */
export async function addOAuth(options: WriterOptions = {}): Promise<string[]> {
  const schemaFile = schemaPathFor(null)
  if (!(await fileExists(process.cwd(), schemaFile))) {
    throw new CliError(
      `guren add oauth keeps OAuth state in an oauth_states table in ${schemaFile}, but this app has no `
      + `${schemaFile}. Nothing was scaffolded.`,
    )
  }

  const definition = await installsConfigDefinition('oauth')
  const created = await writeScaffoldFiles([
    definition
      ? definitionTemplateFile('oauth', 'config/oauth.ts')
      : scaffoldTemplateFile('oauth', 'app/Providers/OAuthProvider.ts'),
    scaffoldTemplateFile('oauth', 'app/Http/Controllers/Auth/OAuthController.ts'),
    scaffoldTemplateFile('oauth', 'routes/oauth.ts'),
  ], options)

  const tableAppended = await appendOAuthStateTable()

  if (definition) {
    await wireConfig('oauth')
  } else {
    await wireProviders([{ name: 'OAuthProvider' }])
  }
  await appendScaffoldEnv(oauthEnvEntries([...KNOWN_OAUTH_PROVIDERS]))
  await registerConsoleCommand('OAuthStatesPruneCommand')
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
  consola.info('  • Schedule `oauth-states:prune` so abandoned sign-ins do not keep their rows')
  if (staleCoreProvider) {
    consola.info(`  • Remove CoreOAuthServiceProvider from ${appEntry}: an earlier scaffold wired it, and ${definition ? 'config/oauth.ts' : 'OAuthProvider'} now binds the manager`)
  }

  return created
}
