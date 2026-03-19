# File Storage

Guren provides a powerful filesystem abstraction that works across multiple storage backends. Store files locally, on S3, or in memory for testing.

## Configuration

Configure storage disks in your application:

```typescript
import { createStorageManager } from '@guren/server'

const storage = createStorageManager({
  default: 'local',
  disks: {
    local: {
      driver: 'local',
      root: './storage/app',
      url: 'http://localhost:3333/storage',
      visibility: 'private',
    },
    public: {
      driver: 'local',
      root: './storage/app/public',
      url: 'http://localhost:3333/storage',
      visibility: 'public',
    },
    s3: {
      driver: 's3',
      bucket: 'my-bucket',
      region: 'ap-northeast-1',
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      visibility: 'private',
    },
  },
})
```

## Basic Usage

### Storing Files

```typescript
// Store from buffer or string
await storage.disk().put('avatars/user-1.jpg', imageBuffer)
await storage.disk().put('documents/readme.txt', 'Hello World')

// Store with options
await storage.disk().put('avatars/user-1.jpg', imageBuffer, {
  visibility: 'public',
  contentType: 'image/jpeg',
  metadata: { userId: '123' },
})

// Store from local file path
await storage.disk().putFile('uploads/document.pdf', '/tmp/uploaded.pdf')
```

### Retrieving Files

```typescript
// Get file as Buffer
const content = await storage.disk().get('avatars/user-1.jpg')

// Get file as string
const text = await storage.disk().getAsString('documents/readme.txt')

// Check if file exists
const exists = await storage.disk().exists('avatars/user-1.jpg')
```

### Deleting Files

```typescript
// Delete single file
await storage.disk().delete('avatars/user-1.jpg')

// Delete multiple files
await storage.disk().deleteMany([
  'avatars/user-1.jpg',
  'avatars/user-2.jpg',
])
```

### Copying & Moving Files

```typescript
// Copy file
await storage.disk().copy('avatars/user-1.jpg', 'backups/user-1.jpg')

// Move file
await storage.disk().move('temp/upload.jpg', 'avatars/user-1.jpg')
```

## File URLs

### Public URLs

```typescript
// Get public URL
const url = storage.disk().url('avatars/user-1.jpg')
// → "http://localhost:3333/storage/avatars/user-1.jpg"
```

### Temporary URLs (Signed)

```typescript
// Get signed URL that expires in 1 hour
const expiration = new Date(Date.now() + 60 * 60 * 1000)
const signedUrl = await storage.disk('s3').temporaryUrl('documents/invoice.pdf', expiration)
```

## File Metadata

```typescript
// Get file size
const size = await storage.disk().size('documents/report.pdf')

// Get last modified date
const lastModified = await storage.disk().lastModified('documents/report.pdf')

// Get full metadata
const metadata = await storage.disk().metadata('documents/report.pdf')
// { path, size, lastModified, contentType, visibility, metadata }
```

## Directory Operations

```typescript
// List files in directory
const files = await storage.disk().files('avatars')
// ['avatars/user-1.jpg', 'avatars/user-2.jpg']

// List all files recursively
const allFiles = await storage.disk().allFiles('uploads')

// List directories
const directories = await storage.disk().directories('uploads')

// Create directory
await storage.disk().makeDirectory('uploads/2024/01')

// Delete directory
await storage.disk().deleteDirectory('uploads/temp')
```

## Visibility

Control file access permissions:

```typescript
// Set visibility
await storage.disk().setVisibility('documents/public.pdf', 'public')
await storage.disk().setVisibility('documents/private.pdf', 'private')

// Get visibility
const visibility = await storage.disk().getVisibility('documents/public.pdf')
// → 'public' or 'private'
```

## Storage Drivers

### Local Driver

Stores files on the local filesystem:

```typescript
{
  driver: 'local',
  root: './storage/app',      // Root directory
  url: 'http://localhost:3333/storage',  // Base URL for public files
  visibility: 'private',      // Default visibility
}
```

### S3 Driver

Stores files on AWS S3 or S3-compatible services:

Install the AWS SDK packages before using the S3 driver:

```bash
bun add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

```typescript
{
  driver: 's3',
  bucket: 'my-bucket',
  region: 'us-east-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  endpoint: 'https://s3.amazonaws.com',  // Custom endpoint for S3-compatible services
  prefix: 'app/',                         // Key prefix
  visibility: 'private',
}
```

### Memory Driver

In-memory storage for testing:

```typescript
{
  driver: 'memory',
  url: 'http://localhost:3333/storage',
}
```

## Multiple Disks

Access different storage disks:

```typescript
// Use default disk
await storage.disk().put('file.txt', 'content')

// Use specific disk
await storage.disk('s3').put('file.txt', 'content')
await storage.disk('public').put('images/logo.png', imageBuffer)
```

## Custom Drivers

Register custom storage drivers:

```typescript
import { StorageDriver } from '@guren/server'

class CloudinaryDriver implements StorageDriver {
  async put(path: string, content: Buffer | string, options?: PutOptions): Promise<string> {
    // Implementation
  }
  // ... implement other methods
}

// Register driver
storage.registerDriver('cloudinary', (options) => new CloudinaryDriver(options))

// Use in config
{
  driver: 'cloudinary',
  cloudName: 'my-cloud',
  apiKey: '...',
}
```

## Controller Integration

Using storage in controllers:

```typescript
import { Controller } from '@guren/server'

export default class UploadController extends Controller {
  async store() {
    const file = await this.request.file('avatar')

    if (!file) {
      return this.json({ error: 'No file uploaded' }, 400)
    }

    const path = `avatars/${Date.now()}-${file.name}`
    await storage.disk().put(path, file.buffer, {
      contentType: file.type,
      visibility: 'public',
    })

    const url = storage.disk().url(path)

    return this.json({ url })
  }
}
```

## CLI Commands

### Create Storage Link

Create a symbolic link from `public/storage` to `storage/app/public`:

```bash
bunx guren storage:link
```

This allows you to serve uploaded files from your public directory.

## Best Practices

1. **Use environment variables** for credentials
2. **Set appropriate visibility** - Use private by default
3. **Generate unique filenames** - Prevent overwrites and conflicts
4. **Use S3 for production** - Better scalability and durability
5. **Use memory driver for tests** - Fast and isolated
6. **Clean up temp files** - Delete files after processing
