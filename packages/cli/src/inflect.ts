import { camelCase, kebabCase } from './utils'

export function pluralize(name: string): string {
  if (/[^aeiou]y$/iu.test(name)) return `${name.slice(0, -1)}ies`
  if (/(s|x|z|ch|sh)$/iu.test(name)) return `${name}es`
  return `${name}s`
}

export function singularize(name: string): string {
  if (/ies$/iu.test(name)) return `${name.slice(0, -3)}y`
  if (/(ches|shes|sses|xes|zes)$/iu.test(name)) return name.slice(0, -2)
  if (/s$/iu.test(name) && !/ss$/iu.test(name)) return name.slice(0, -1)
  return name
}

/**
 * Collection name for a resource, tolerant of input that is already plural.
 *
 * Every scaffolder must route through this: the schema export, the model's
 * import of it, and `guren check`'s lookup are three independent derivations
 * that only agree if they share one rule.
 *
 * A lone trailing `s` is read as plural, so a singular `Status` becomes
 * `Statu`. English cannot resolve that without a dictionary — `News` and
 * `Status` are structurally identical — which is why only the names inside the
 * triangle route through here. Route slugs and generated type names in
 * `make:feature` pluralize directly, so `Status` still yields `/statuses`.
 */
export function collectionName(name: string): string {
  return pluralize(singularize(name))
}

/** Kebab slug of the collection: the route path and page directory. */
export function collectionSlug(name: string): string {
  return kebabCase(collectionName(name))
}

export function schemaIdentifierFor(name: string): string {
  return camelCase(collectionName(name))
}

export function tableNameFor(name: string): string {
  return collectionSlug(name).replaceAll('-', '_')
}
