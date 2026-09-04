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
    // getStream() against the real binding: full body, an inclusive range
    // (mapped to R2's offset/length form), and the null contract.
    const readText = async (stream: ReadableStream<Uint8Array> | null) =>
      stream && new TextDecoder().decode(await new Response(stream).arrayBuffer())
    const streamedFull = await readText(await driver.getStream('moved.txt'))
    const streamedRange = await readText(
      await driver.getStream('moved.txt', { range: { start: 1, end: 3 } }),
    )
    const missingStream = await driver.getStream('missing.txt')
    // Presigning must work from inside the bundle: the signer has to be reachable
    // through the bundler, which a variable-specifier dynamic import is not.
    const presigning = new R2Driver({
      binding: () => env.BUCKET,
      presign: { accountId: 'acct', bucket: 'b', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
    })
    let signedUrl: string
    try {
      signedUrl = await presigning.temporaryUrl('a b.png', new Date(Date.now() + 3600_000))
    } catch (error) {
      signedUrl = `ERROR: ${String(error)}`
    }
    return Response.json({
      signedUrl,
      copied,
      bytesAreBuffer: bytes instanceof Buffer,
      bytes: Array.from(bytes ?? []),
      streamedFull,
      streamedRange,
      missingStreamIsNull: missingStream === null,
      moved: await driver.getAsString('moved.txt'),
      copyExistsAfterMove: await driver.exists('copy.txt'),
      sourceExists: await driver.exists('src.txt'),
      contentType: metadata?.contentType,
      metadata: metadata?.metadata,
    })
  },
}
