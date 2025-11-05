import chalk from 'chalk'
import figlet from 'figlet'
import packageJson from '../../package.json' assert { type: 'json' }

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
}

export function logDevServerBanner({
  hostname,
  port,
  assetsUrl = 'http://localhost:5173',
}: DevBannerOptions): void {
  const localUrl = `http://localhost:${port}`
  const boundUrl = `http://${hostname}:${port}`
  const boundLabel =
    hostname === '0.0.0.0' || hostname === '::' ? ' (all interfaces)' : ''

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
    detail('Asset server', `${assetsUrl} (Vite)`),
    '',
    chalk.yellowBright('Press Ctrl+C to douse the flames.'),
    '',
  ].join('\n')

  console.log(banner)
}
