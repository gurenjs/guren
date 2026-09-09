// Companion for typechecking templates/scaffold/prototype (tsconfig.templates.json):
// the manifest shape `guren codegen` writes, with the one route the default
// template registers.

export const routeManifest = {
  home: { method: 'GET', path: '/' },
} as const
