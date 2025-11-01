import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { consola } from 'consola'
import { defineCommand, runMain } from 'citty'
import { directoryExists, isDirectoryEmpty, toPackageName, toTitleCase } from './utils'

async function ensureTargetDirectory(path: string, force: boolean): Promise<void> {
  try {
    await mkdir(path, { recursive: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Path "${path}" exists and is not a directory.`)
    }

    throw error
  }

  if (!force) {
    const empty = await isDirectoryEmpty(path)
    if (!empty) {
      throw new Error(`Directory "${path}" is not empty. Use --force to scaffold anyway.`)
    }
  }
}

async function copyTemplate(template: string, destination: string): Promise<void> {
  await cp(template, destination, { recursive: true, force: true })
}

async function replaceTokens(destination: string, files: string[], tokens: Map<string, string>): Promise<void> {
  for (const file of files) {
    const path = join(destination, file)
    const content = await readFile(path, 'utf8')
    let updated = content

    for (const [token, replacement] of tokens) {
      updated = updated.split(token).join(replacement)
    }

    if (updated !== content) {
      await writeFile(path, updated, 'utf8')
    }
  }
}

const command = defineCommand({
  meta: {
    name: 'create-guren-app',
    description: 'Scaffold a new Guren application.',
  },
  args: {
    target: {
      type: 'positional',
      description: 'Directory to create the application in',
      default: '.',
    },
    force: {
      type: 'boolean',
      alias: 'f',
      description: 'Overwrite existing files in the target directory',
    },
  },
  async run({ args }) {
    const target = args.target as string
    const force = Boolean(args.force)
    const templateName = 'default'

    const templateDir = fileURLToPath(new URL(`../templates/${templateName}`, import.meta.url))
    const targetDir = resolve(process.cwd(), target)

    if (await directoryExists(targetDir)) {
      if (!force) {
        const empty = await isDirectoryEmpty(targetDir)
        if (!empty) {
          throw new Error(`Directory "${targetDir}" is not empty. Use --force to scaffold anyway.`)
        }
      }
    } else {
      await ensureTargetDirectory(targetDir, true)
    }

    const appName = basename(targetDir)
    const packageName = toPackageName(appName)
    const appTitle = toTitleCase(appName)

    await copyTemplate(templateDir, targetDir)

    const tokenMap = new Map<string, string>([
      ['guren-app-placeholder', packageName],
      ['__APP_TITLE__', appTitle],
      ['__APP_NAME__', appName],
    ])

    const filesToTransform = [
      'README.md',
      'package.json',
      'public/index.html',
      'bin/serve.ts',
      'app/Http/Controllers/HomeController.ts',
      'resources/js/pages/Home.tsx',
    ]

    await replaceTokens(targetDir, filesToTransform, tokenMap)

    const relativeTarget = relative(process.cwd(), targetDir) || '.'

    consola.success(`Scaffolded a new Guren app in ${relativeTarget}`)
    consola.info('Next steps:')
    if (relativeTarget !== '.') {
      consola.log(`  cd ${relativeTarget}`)
    }
    consola.log('  bun install')
    consola.log('  bun run dev')
  },
})

runMain(command).catch((error) => {
  if (error instanceof Error) {
    consola.error(error.message)
  } else {
    consola.error(String(error))
  }
  process.exit(1)
})
