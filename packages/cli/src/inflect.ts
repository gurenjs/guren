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
 * Collection name for a resource, tolerant of already-plural input. The schema
 * export, the model's import of it, and `guren check`'s lookup only agree
 * because all three derive the name here. A lone trailing `s` reads as plural,
 * so a singular `Status` becomes `Statu`; route slugs and generated type names
 * pluralize directly, and `dbArtifactPattern()` treats the result as one spelling.
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
