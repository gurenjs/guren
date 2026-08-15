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
  visibility: 'public',
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

```ts
const disk = storage.disk()

// Set visibility on upload
await disk.put('file.txt', content, { visibility: 'public' })

// Change visibility
await disk.setVisibility('file.txt', 'public')
await disk.setVisibility('file.txt', 'private')

// Get current visibility
const visibility = await disk.getVisibility('file.txt')
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

> [!NOTE]
> On Cloudflare Workers, use the bucket binding instead of the S3 API: `R2Driver` from `@guren/plugin-cloudflare` needs no credentials and no AWS SDK. The S3 recipe above is for reaching R2 from other runtimes (a Bun server, a script, Lambda). R2 has no per-object ACLs, so treat visibility as a bucket-level setting there. See the [Cloudflare Workers guide](./cloudflare.md#storage-r2).

### Pre-signed URLs

Generate temporary URLs for private files:

```ts
const disk = storage.disk('s3')

// URL valid for 1 hour
const expiration = new Date(Date.now() + 3600 * 1000)
const url = await disk.temporaryUrl('private/document.pdf', expiration)
```

## File Uploads

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

    await storage.disk().put(filename, buffer, {
      contentType: file.type,
      visibility: 'public',
    })

    const url = storage.disk().url(filename)

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

5. **Use pre-signed URLs**: For private files, generate temporary URLs instead of making them public.

6. **Organize with directories**: Use meaningful directory structures (`avatars/`, `documents/`, etc.).

7. **Use Memory driver for testing**: Avoid filesystem or network calls in tests.

8. **Handle errors gracefully**: Check for null returns from `get()` and `metadata()`.
