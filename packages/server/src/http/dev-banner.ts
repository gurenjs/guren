import chalk from 'chalk'
import figlet from 'figlet'
import standard from 'figlet/importable-fonts/Standard.js'
import packageJson from '../../package.json' with { type: 'json' }
import { formatHostPort, isWildcardHost } from './host-port'
import { DEFAULT_DEV_SERVER_URL } from './vite-manifest'

figlet.parseFont('Standard', standard)

function generateAsciiArt(text: string): string {
  try {
    const rendered = figlet.textSync(text, {
      font: 'Standard',
      horizontalLayout: 'default',
      verticalLayout: 'default',
    })

    return rendered
  } catch (error) {
    console.error('Failed to generate FIGlet banner, falling back to plain text:', error)
    return text.toUpperCase()
  }
}

export const GUREN_ASCII_ART = chalk.redBright.bold(generateAsciiArt('GUREN'))

const GUREN_VERSION = packageJson.version

export interface DevBannerOptions {
  hostname: string
  port: number
  assetsUrl?: string
  /**
   * `managed` when `listen()` started or adopted the Vite dev server at `assetsUrl`; `external` when it
   * started none (`VITE_DEV_SERVER_URL`, `assetsUrl`, `vite: false`, `GUREN_DEV_VITE=0`). Omitted, the line reads `(Vite)`.
   */
  assetServer?: 'managed' | 'external'
}

const ASSET_SERVER_LABELS = {
  managed: 'Vite, started by Guren',
  external: 'not started by Guren, run it yourself',
} as const

export function logDevServerBanner({
  hostname,
  port,
  assetsUrl = DEFAULT_DEV_SERVER_URL,
  assetServer,
}: DevBannerOptions): void {
  const localUrl = `http://localhost:${port}`
  const boundUrl = `http://${formatHostPort(hostname, port)}`
  const boundLabel = isWildcardHost(hostname) ? ' (all interfaces)' : ''

  const header = [
    GUREN_ASCII_ART,
    chalk.magentaBright.bold(
      `Guren v${GUREN_VERSION} ignites — burning bright like a crimson lotus.`,
    ),
    '',
  ]

  const detail = (label: string, value: string) =>
    `${chalk.magentaBright('   •')} ${chalk.bold(label.padEnd(14))}: ${chalk.cyanBright(value)}`

  const banner = [
    ...header,
    detail('App URL', localUrl),
    detail('Bound address', `${boundUrl}${boundLabel}`),
    detail('Asset server', `${assetsUrl} (${assetServer ? ASSET_SERVER_LABELS[assetServer] : 'Vite'})`),
    '',
    chalk.yellowBright('Press Ctrl+C to douse the flames.'),
    '',
  ].join('\n')

  console.log(banner)
}
