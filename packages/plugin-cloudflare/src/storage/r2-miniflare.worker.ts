// Worker entry for r2-miniflare.test.ts — bundled with Bun.build at test
// time and executed inside workerd, so the driver's streaming copy runs
// against the real binding rather than Miniflare's proxy.
import { R2Driver } from './R2Driver'

export default {
  async fetch(_request: Request, env: { BUCKET: unknown }): Promise<Response> {
    const driver = new R2Driver({ binding: () => env.BUCKET, prefix: 'app' })
    await driver.deleteDirectory('')
    await driver.put('src.txt', 'content', { contentType: 'text/plain', metadata: { k: 'v' } })
    await driver.copy('src.txt', 'copy.txt')
    const copied = await driver.getAsString('copy.txt')
    await driver.move('copy.txt', 'moved.txt')
    const metadata = await driver.metadata('moved.txt')
    // get() returns a Buffer — proves nodejs_compat's Buffer global is there.
    const bytes = await driver.get('moved.txt')
    return Response.json({
      copied,
      bytesAreBuffer: bytes instanceof Buffer,
      bytes: Array.from(bytes ?? []),
      moved: await driver.getAsString('moved.txt'),
      copyExistsAfterMove: await driver.exists('copy.txt'),
      sourceExists: await driver.exists('src.txt'),
      contentType: metadata?.contentType,
      metadata: metadata?.metadata,
    })
  },
}
