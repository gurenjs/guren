export type PagePropsRecord = Record<string, unknown>

export interface DefinePageOptions {
  path?: string
}

export type PageContract<TId extends string = string, TProps extends PagePropsRecord = Record<string, never>> = {
  readonly id: TId
  readonly component: TId
  readonly path?: string
  readonly __props?: TProps
  props<TNextProps extends PagePropsRecord>(): PageContract<TId, TNextProps>
}

export type AnyPageContract = PageContract<string, PagePropsRecord>

export type PageId<TPage extends PageContract<string, PagePropsRecord>> = TPage['id']

export type PageProps<TPage extends PageContract<string, PagePropsRecord>> =
  NonNullable<TPage['__props']>

export type PageManifest = Record<string, string>

export function definePage<TId extends string>(
  id: TId,
  options: DefinePageOptions = {},
): PageContract<TId, Record<string, never>> {
  return {
    id,
    component: id,
    path: options.path,
    props<TNextProps extends PagePropsRecord>() {
      return definePage(id, options) as PageContract<TId, TNextProps>
    },
  } as PageContract<TId, Record<string, never>>
}

export function resolvePagePath<TPageName extends string>(
  name: TPageName,
  manifest: PageManifest,
): string | undefined {
  return manifest[name]
}
