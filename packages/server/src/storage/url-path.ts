/** Encode object-key segments without turning directory separators into data. */
export function encodeStoragePath(path: string): string {
  return path.split('/').map((segment) => encodeURIComponent(segment)).join('/')
}
