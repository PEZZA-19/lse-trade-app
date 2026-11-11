/**
 * Where job photos live. Production will use a Cloudflare R2 bucket binding; there is no
 * Cloudflare account yet, so the Worker gets UnconfiguredBlobs (uploads fail loudly rather than
 * pretend) and local dev/tests use MemoryBlobs. Postgres keeps only the index (job_photos).
 */
export interface StoredBlob {
  bytes: Uint8Array;
  contentType: string;
}

export interface BlobStore {
  readonly name: string;
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<StoredBlob | null>;
  delete(key: string): Promise<void>;
}

export class MemoryBlobs implements BlobStore {
  readonly name = 'memory';
  private readonly items = new Map<string, StoredBlob>();
  async put(key: string, bytes: Uint8Array, contentType: string) {
    this.items.set(key, { bytes: bytes.slice(), contentType });
  }
  async get(key: string) {
    return this.items.get(key) ?? null;
  }
  async delete(key: string) {
    this.items.delete(key);
  }
  get size() {
    return this.items.size;
  }
}

export class BlobsNotConfigured extends Error {
  constructor() {
    super('Photo storage is not set up yet');
    this.name = 'BlobsNotConfigured';
  }
}

export class UnconfiguredBlobs implements BlobStore {
  readonly name = 'unconfigured';
  async put(): Promise<void> {
    throw new BlobsNotConfigured();
  }
  async get() {
    return null;
  }
  async delete() {}
}

/** Minimal shape of a Workers R2 bucket binding, so this compiles without the Workers types here. */
export interface R2Like {
  put(
    key: string,
    value: Uint8Array,
    opts?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<{
    arrayBuffer(): Promise<ArrayBuffer>;
    httpMetadata?: { contentType?: string };
  } | null>;
  delete(key: string): Promise<void>;
}

/** Ready for when an R2 bucket is bound as PHOTOS. Not used anywhere yet. */
export class R2Blobs implements BlobStore {
  readonly name = 'r2';
  constructor(private readonly bucket: R2Like) {}
  async put(key: string, bytes: Uint8Array, contentType: string) {
    await this.bucket.put(key, bytes, { httpMetadata: { contentType } });
  }
  async get(key: string) {
    const o = await this.bucket.get(key);
    if (!o) return null;
    return {
      bytes: new Uint8Array(await o.arrayBuffer()),
      contentType: o.httpMetadata?.contentType ?? 'application/octet-stream',
    };
  }
  async delete(key: string) {
    await this.bucket.delete(key);
  }
}

/** The file really is the type it claims (magic bytes), so a renamed file can't be served as an image. */
export function sniffImage(bytes: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';
  if (
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)
  )
    return 'image/png';
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  )
    return 'image/webp';
  return null;
}
