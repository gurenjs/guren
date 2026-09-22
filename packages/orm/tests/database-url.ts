/** The same server, another database: what a fixture derives from the URL an app puts in DATABASE_URL. */
export function databaseUrl(url: string, database: string): string {
  const target = new URL(url)
  target.pathname = `/${database}`
  return target.toString()
}
