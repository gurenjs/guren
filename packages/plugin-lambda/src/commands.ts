import { defineCommand } from 'citty'
import { DATABASE_DIALECTS, parseDatabaseDialects } from '@guren/core/internal/deploy-build'
import { buildLambdaOutput } from './build'

const lambdaBuild = defineCommand({
  meta: {
    name: 'lambda:build',
    description: 'Assemble an AWS Lambda deployment (.lambda/) from the app build',
  },
  args: {
    root: {
      type: 'string',
      description: 'App root directory (defaults to the current working directory)',
    },
    'skip-app-build': {
      type: 'boolean',
      description: "Skip running the app's build script before assembling output",
    },
    zip: {
      type: 'boolean',
      description: 'Also produce .lambda/function.zip (requires the zip binary)',
    },
    database: {
      type: 'string',
      description:
        `Databases this app connects to (comma-separated: ${DATABASE_DIALECTS.join(', ')}). `
        + 'Defaults to what config/database.ts declares; every other dialect\'s client is stubbed out of the bundle.',
    },
  },
  async run({ args }) {
    await buildLambdaOutput({
      rootDir: args.root || process.cwd(),
      skipAppBuild: Boolean(args['skip-app-build']),
      zip: Boolean(args.zip),
      databaseDialects: args.database ? parseDatabaseDialects(args.database, 'Lambda build') : undefined,
    })
  },
})

export default {
  'lambda:build': lambdaBuild,
}
