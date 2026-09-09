// Companion for typechecking templates/scaffold/prototype (tsconfig.templates.json):
// the `ApiRoutes` shape `guren codegen` writes for an app whose routes declare
// no body schema.

export interface ApiRoutes {
  home: { method: 'GET'; path: '/' }
}
