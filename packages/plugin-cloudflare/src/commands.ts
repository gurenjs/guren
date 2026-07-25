import { defineCommand } from 'citty'
import { buildCloudflareOutput } from './build'

const cloudflareBuild = defineCommand({
  meta: {
    name: 'cloudflare:build',
    description: 'Assemble a Cloudflare Workers deployment (.cloudflare/) from the app build',
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
  },
  async run({ args }) {
    await buildCloudflareOutput({
      rootDir: args.root || process.cwd(),
      skipAppBuild: Boolean(args['skip-app-build']),
    })
  },
})

export default {
  'cloudflare:build': cloudflareBuild,
}
