import { defineCommand } from 'citty'
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
  },
  async run({ args }) {
    await buildLambdaOutput({
      rootDir: args.root || process.cwd(),
      skipAppBuild: Boolean(args['skip-app-build']),
      zip: Boolean(args.zip),
    })
  },
})

export default {
  'lambda:build': lambdaBuild,
}
