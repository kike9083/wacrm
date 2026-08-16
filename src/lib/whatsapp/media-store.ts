import { ID } from 'node-appwrite'
import { InputFile } from 'node-appwrite/file'
import { createAdminClient } from '@/lib/appwrite/server'

/**
 * WAHA/WhatsApp media lives in the provider's temporary storage and can
 * expire or vanish on restart. To keep client media durable, the webhook
 * persists each file into Appwrite Storage (`whatsapp-media` bucket) and
 * the proxy serves from there, falling back to the live provider only
 * for legacy messages that predate persistence.
 */

export const MEDIA_BUCKET_ID = 'whatsapp-media'

/** Sanitize a provider media id into a safe filename (keeps extension). */
export function sanitizeMediaFilename(mediaId: string): string {
  return mediaId.replace(/[^\w.-]/g, '_').slice(-100)
}

export async function persistMediaToAppwrite(
  buffer: Buffer,
  filename: string,
): Promise<string | null> {
  try {
    const { storage } = createAdminClient()
    const file = await storage.createFile(
      MEDIA_BUCKET_ID,
      ID.unique(),
      InputFile.fromBuffer(buffer, filename),
    )
    return file.$id
  } catch (error) {
    console.error(
      'Failed to persist media to Appwrite:',
      error instanceof Error ? error.message : error,
    )
    return null
  }
}

export async function fetchMediaFromAppwrite(
  fileId: string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  try {
    const { storage } = createAdminClient()
    const [file, download] = await Promise.all([
      storage.getFile(MEDIA_BUCKET_ID, fileId),
      storage.getFileDownload(MEDIA_BUCKET_ID, fileId),
    ])
    return {
      buffer: Buffer.from(download),
      contentType: file.mimeType || 'application/octet-stream',
    }
  } catch {
    // Not found in the bucket (or id never was an Appwrite file id).
    return null
  }
}
