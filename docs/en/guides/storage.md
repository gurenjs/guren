# Storage Guide

Guren provides a unified file storage API with support for multiple storage backends. The storage system makes it easy to work with local filesystems, Amazon S3, and other cloud storage providers with a consistent interface.

## Core Concepts

- **StorageManager** – Central registry for configuring and accessing multiple storage disks.
- **StorageDriver** – Interface for storage operations (put, get, delete, etc.). All drivers implement this interface.
- **Drivers** – Storage backends: Local (filesystem), S3 (AWS/compatible), and Memory (testing).

## Basic Usage

### Quick Start

```ts
import { StorageManager } from '@guren/core'

const storage = new StorageManager({
  default: 'local',
  disks: {
    local: {
      driver: 'local',
      root: './storage/app',
      url: '/storage',
    },
  },
})

// Store a file
await storage.disk().put('avatars/user-1.jpg', imageBuffer)

// Retrieve a file
const content = await storage.disk().get('avatars/user-1.jpg')

// Check if file exists
const exists = await storage.disk().exists('avatars/user-1.jpg')

// Delete a file
await storage.disk().delete('avatars/user-1.jpg')
```

### File Operations

```ts
const disk = storage.disk()

// Storing files
await disk.put('file.txt', 'Hello World')                    // String content
await disk.put('image.jpg', imageBuffer)                      // Buffer content
await disk.put('data.json', JSON.stringify(data), {          // With options
  contentType: 'application/json',
})
await disk.putFile('uploads/report.pdf', './temp/report.pdf') // From local file

// Retrieving files
const buffer = await disk.get('file.txt')                    // Get as Buffer
const text = await disk.getAsString('file.txt')              // Get as string

// File existence
const exists = await disk.exists('file.txt')

// Deleting files
await disk.delete('file.txt')                                // Single file
await disk.deleteMany(['file1.txt', 'file2.txt'])            // Multiple files

// Copying and moving
await disk.copy('original.txt', 'copy.txt')
await disk.move('old-path.txt', 'new-path.txt')
```

### File Metadata

```ts
const disk = storage.disk()

// Get file size (bytes)
const size = await disk.size('file.txt')

// Get last modified date
const lastModified = await disk.lastModified('file.txt')

// Get all metadata
const metadata = await disk.metadata('file.txt')
// { path, size, lastModified, contentType?, visibility?, metadata? }
```

### URLs

```ts
const disk = storage.disk()

// Get public URL
const url = disk.url('avatars/user-1.jpg')
// e.g., '/storage/avatars/user-1.jpg' (local)
// e.g., 'https://bucket.s3.region.amazonaws.com/avatars/user-1.jpg' (S3)

// Get temporary signed URL (S3 only)
const expiration = new Date(Date.now() + 3600 * 1000) // 1 hour
const signedUrl = await disk.temporaryUrl('private/report.pdf', expiration)
```

### Directories

```ts
const disk = storage.disk()

// List files in directory
const files = await disk.files('uploads')              // Direct children only
const allFiles = await disk.allFiles('uploads')        // Recursive

// List subdirectories
const dirs = await disk.directories('uploads')

// Create directory
await disk.makeDirectory('uploads/images')

// Delete directory (with contents)
await disk.deleteDirectory('uploads/temp')
```

### Visibility

Where visibility lives depends on the backend, and the driver tells you which one you have rather than pretending:

- **Per object** — S3 with ACLs enabled. `setVisibility()` changes one file.
- **Per disk** — a local disk (reachability comes from the disk root and whatever serves it), S3 with `acl: false`, and Cloudflare R2. The disk declares its `visibility`; asking for the other value is refused instead of silently doing nothing. On S3 and R2 that is an error today; the local driver warns and will error in the next major, since it has been accepting these calls for a while.

```ts
const disk = storage.disk('public')       // declared visibility: 'public'

await disk.put('file.txt', content)                  // inherits the disk's visibility
await disk.put('file.txt', content, { visibility: 'public' })  // same thing, stated explicitly
await disk.getVisibility('file.txt')                 // 'public' — throws if the file is not there

// On a per-object backend this moves one file:
await storage.disk('s3').setVisibility('file.txt', 'private')

// On a per-disk backend the request is refused rather than silently
// dropped. Put the file on a disk with the visibility you want instead:
await storage.disk('local').put('secret.pdf', content)
```

## Configuration

### Multiple Disks

Configure multiple storage backends in your application:

```ts
import { StorageManager } from '@guren/core'

const storage = new StorageManager({
  default: 'local',
  disks: {
    local: {
      driver: 'local',
      root: './storage/app',
      url: '/storage',
      visibility: 'private',
    },
    public: {
      driver: 'local',
      root: './storage/public',
      url: '/files',
      visibility: 'public',
    },
    s3: {
      driver: 's3',
      bucket: process.env.AWS_BUCKET!,
      region: process.env.AWS_REGION ?? 'us-east-1',
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      visibility: 'private',
    },
    memory: {
      driver: 'memory',
    },
  },
})

// Use default disk (local)
await storage.disk().put('file.txt', 'content')

// Use specific disk
await storage.disk('s3').put('uploads/file.txt', content)
await storage.disk('public').put('images/logo.png', logoBuffer)
```

### Driver Options

**Local Driver:**
| Option | Default | Description |
|--------|---------|-------------|
| `root` | required | Root directory for file storage |
| `url` | `''` | Base URL for public file access |
| `visibility` | `'private'` | Default visibility for new files |

**S3 Driver:**
| Option | Default | Description |
|--------|---------|-------------|
| `bucket` | required | S3 bucket name |
| `region` | `'us-east-1'` | AWS region |
| `endpoint` | - | Custom endpoint (for S3-compatible services) |
| `accessKeyId` | - | AWS access key ID |
| `secretAccessKey` | - | AWS secret access key |
| `prefix` | `''` | Key prefix for all files |
| `url` | auto | Base URL for public access |
| `visibility` | `'private'` | Default visibility for new files |

**Memory Driver:**
| Option | Default | Description |
|--------|---------|-------------|
| `url` | `''` | Base URL for file URLs |

## S3 Configuration

### AWS S3

```ts
const storage = new StorageManager({
  default: 's3',
  disks: {
    s3: {
      driver: 's3',
      bucket: 'my-bucket',
      region: 'ap-northeast-1',
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  },
})
```

### S3-Compatible Services

For services like MinIO, DigitalOcean Spaces, or Cloudflare R2:

```ts
// MinIO
const storage = new StorageManager({
  default: 's3',
  disks: {
    s3: {
      driver: 's3',
      bucket: 'my-bucket',
      region: 'us-east-1',
      endpoint: 'http://localhost:9000',
      accessKeyId: 'minioadmin',
      secretAccessKey: 'minioadmin',
    },
  },
})

// DigitalOcean Spaces
const storage = new StorageManager({
  default: 's3',
  disks: {
    s3: {
      driver: 's3',
      bucket: 'my-space',
      region: 'nyc3',
      endpoint: 'https://nyc3.digitaloceanspaces.com',
      accessKeyId: process.env.DO_SPACES_KEY,
      secretAccessKey: process.env.DO_SPACES_SECRET,
      url: 'https://my-space.nyc3.cdn.digitaloceanspaces.com',
    },
  },
})

// Cloudflare R2
const storage = new StorageManager({
  default: 's3',
  disks: {
    s3: {
      driver: 's3',
      bucket: 'my-bucket',
      region: 'auto',
      endpoint: `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  },
})
```

Endpoints that do not implement S3 object ACLs — R2 documents `x-amz-acl` and the ACL operations as unsupported, and MinIO deployments vary — need `acl: false`. The driver then stops sending the header, `getVisibility()` reports the disk's configured `visibility`, and `put({ visibility })` / `setVisibility()` throw when asked for the other value instead of silently not applying it:

```ts
const storage = new StorageManager({
  default: 's3',
  disks: {
    s3: {
      driver: 's3',
      bucket: 'my-bucket',
      region: 'auto',
      endpoint: `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      acl: false,
      visibility: 'public',
    },
  },
})
```

> [!NOTE]
> On Cloudflare Workers, use the bucket binding instead of the S3 API: `R2Driver` from `@guren/plugin-cloudflare` needs no credentials and no AWS SDK. The S3 recipe above is for reaching R2 from other runtimes (a Bun server, a script, Lambda). See the [Cloudflare Workers guide](./cloudflare.md#storage-r2).

### Pre-signed URLs

Generate temporary URLs for private files:

```ts
const disk = storage.disk('s3')

// URL valid for 1 hour
const expiration = new Date(Date.now() + 3600 * 1000)
const url = await disk.temporaryUrl('private/document.pdf', expiration)
```

### Choosing a Disk per Environment

Declare every disk once and pick one with an environment variable, the way `bunx guren add storage` scaffolds it. Drivers are built on first use, so a disk you never touch never constructs a client or opens a connection:

```ts
const storage = createStorageManager({
  default: process.env.STORAGE_DISK ?? 'local',
  disks: {
    // Not served by anything. Uploads belong here — see the note below.
    local: { driver: 'local', root: './storage/app' },
    // Served, because it is inside public/. For assets you ship.
    public: { driver: 'local', root: './public/storage', url: '/storage', visibility: 'public' },
    s3: { driver: 's3', bucket: process.env.S3_BUCKET!, region: 'ap-northeast-1' },
  },
})
```

`STORAGE_DISK=local` in development, `STORAGE_DISK=s3` in production — no code change, and `storage.disk()` returns whichever one is selected.

> **Do not root a disk that receives uploads inside `public/`, or anywhere `guren storage:link` exposes.** Everything under the served tree is fetchable by URL with no signature, no expiry and no authorization check — including files a stranger uploaded. Keep uploads on a disk like `local` above and hand them out through the [attachments delivery route](./attachments.md); `guren check` fails an attachments config whose disk is reachable that way.

Two things to know about this shape:

- **The config values are read eagerly**, even for a disk you never resolve — they are evaluated when you build the object. `process.env.S3_BUCKET` being unset is harmless, but a helper that *throws* on a missing variable will throw at startup for a disk the app never touches. Keep those out of the disk map, or build that disk with `storage.registerDisk('s3', () => new S3Driver({ ... }))`, whose callback really does run on first use.
- **An unknown name is not caught at construction.** `createStorageManager({ default: 'typo' })` succeeds and only throws `Storage disk not found: typo` when a disk is first resolved — which can be inside a queued job. The scaffolded provider checks the value against its own disk map at boot for this reason; do the same if you write the config by hand.

## File Uploads

> For uploads that belong to a model — a post's cover image, a user's
> avatar — the [attachments layer](./attachments.md) handles naming,
> storage, image validation, thumbnail variants, and cleanup in one call
> (`Post.attach(post.id, 'cover', file)`). The recipes below are the
> lower-level, path-oriented storage API.

### Handling Form Uploads

```ts
import { Controller } from '@guren/core'

export class UploadController extends Controller {
  async store() {
    const formData = await this.request.formData()
    const file = formData.get('avatar') as File

    if (!file) {
      return this.json({ error: 'No file uploaded' }, 400)
    }

    // Validate file
    if (!file.type.startsWith('image/')) {
      return this.json({ error: 'Invalid file type' }, 400)
    }

    if (file.size > 5 * 1024 * 1024) { // 5MB
      return this.json({ error: 'File too large' }, 400)
    }

    // Store the file
    const buffer = Buffer.from(await file.arrayBuffer())
    const ext = file.name.split('.').pop()
    const filename = `avatars/${crypto.randomUUID()}.${ext}`

    // The public disk declares its own visibility, so the upload does not
    // have to ask for one the disk may not be able to honour.
    await storage.disk('public').put(filename, buffer, {
      contentType: file.type,
    })

    const url = storage.disk('public').url(filename)

    return this.json({ url })
  }
}
```

### Streaming Large Files

For large files, consider streaming:

```ts
import { Controller } from '@guren/core'

export class DownloadController extends Controller {
  async show() {
    const path = this.request.param('path')
    const content = await storage.disk().get(path)

    if (!content) {
      return this.notFound()
    }

    const metadata = await storage.disk().metadata(path)

    return new Response(content, {
      headers: {
        'Content-Type': metadata?.contentType ?? 'application/octet-stream',
        'Content-Length': String(content.length),
        'Content-Disposition': `attachment; filename="${path.split('/').pop()}"`,
      },
    })
  }
}
```

## Testing

Use the Memory driver for testing:

```ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { StorageManager, MemoryDriver } from '@guren/core'

describe('File uploads', () => {
  let storage: StorageManager

  beforeEach(() => {
    storage = new StorageManager({
      default: 'memory',
      disks: {
        memory: { driver: 'memory' },
      },
    })
  })

  test('stores uploaded file', async () => {
    const content = Buffer.from('test content')
    await storage.disk().put('test.txt', content)

    expect(await storage.disk().exists('test.txt')).toBe(true)
    expect(await storage.disk().getAsString('test.txt')).toBe('test content')
  })

  test('deletes file', async () => {
    await storage.disk().put('test.txt', 'content')
    await storage.disk().delete('test.txt')

    expect(await storage.disk().exists('test.txt')).toBe(false)
  })

  test('lists files in directory', async () => {
    await storage.disk().put('uploads/file1.txt', 'content1')
    await storage.disk().put('uploads/file2.txt', 'content2')

    const files = await storage.disk().files('uploads')
    expect(files).toHaveLength(2)
  })
})
```

## Best Practices

1. **Use environment variables**: Never hardcode credentials or bucket names.

2. **Validate uploads**: Always validate file types, sizes, and content before storing.

3. **Generate unique filenames**: Avoid collisions by using UUIDs or timestamps.

4. **Use appropriate visibility**: Default to private; only make files public when necessary.

5. **Use pre-signed URLs**: For private files, generate temporary URLs instead of making them public. For model attachments, the [signed delivery route](./attachments.md#urls-and-visibility) covers this on every driver — local disks and binding-only R2 included.

6. **Organize with directories**: Use meaningful directory structures (`avatars/`, `documents/`, etc.).

7. **Use Memory driver for testing**: Avoid filesystem or network calls in tests.

8. **Handle errors gracefully**: Check for null returns from `get()` and `metadata()`.
