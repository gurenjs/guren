import type { ScaffoldEnvEntry } from './service-scaffold'

/** The providers `make:auth --oauth` accepts and `guren add oauth` scaffolds. */
export const KNOWN_OAUTH_PROVIDERS = ['github', 'google', 'discord'] as const

export const OAUTH_PROVIDER_LABELS: Record<string, string> = {
  github: 'GitHub',
  google: 'Google',
  discord: 'Discord',
}

/** The keys `config/oauth.ts` and `OAuthProvider.ts` read, each blank until the app registers with the provider. */
export function oauthEnvEntries(providers: string[]): ScaffoldEnvEntry[] {
  return providers.flatMap((provider) => {
    const upper = provider.toUpperCase()
    return [
      {
        key: `OAUTH_${upper}_CLIENT_ID`,
        entry: `\n# Sign-in with ${OAUTH_PROVIDER_LABELS[provider]} is offered once all three OAUTH_${upper}_* keys are set.\nOAUTH_${upper}_CLIENT_ID=\n`,
      },
      { key: `OAUTH_${upper}_CLIENT_SECRET`, entry: `OAUTH_${upper}_CLIENT_SECRET=\n`, declare: { secret: true } },
      { key: `OAUTH_${upper}_REDIRECT_URI`, entry: `OAUTH_${upper}_REDIRECT_URI=\n`, declare: { type: 'url' } },
    ]
  })
}
