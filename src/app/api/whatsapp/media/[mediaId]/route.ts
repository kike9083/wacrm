import { NextResponse } from 'next/server'
import { createAdminClient, createSessionClient } from '@/lib/appwrite/server'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'
import { Query } from 'node-appwrite'
import { createDriver, getDriverType } from '@/lib/whatsapp/driver'
import { decrypt } from '@/lib/whatsapp/encryption'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const { mediaId } = await params

    if (!mediaId) {
      return NextResponse.json(
        { error: 'Media ID is required' },
        { status: 400 }
      )
    }

    const { account } = await createSessionClient()
    let user
    try {
      user = await account.get()
    } catch {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const driverType = getDriverType()
    let driver

    if (driverType === 'evolution') {
      driver = createDriver('evolution', { instanceName: process.env.EVOLUTION_INSTANCE_NAME || 'default' })
    } else {
      // Fetch and decrypt WhatsApp config for Meta
      const { databases } = createAdminClient()
      let configs
      try {
        configs = await databases.listDocuments(
          DATABASE_ID,
          COLLECTIONS.whatsappConfig,
          [Query.equal('user_id', user.$id)]
        )
      } catch {
        return NextResponse.json(
          { error: 'WhatsApp not configured' },
          { status: 400 }
        )
      }
      const config = configs.documents[0]
      if (!config) {
        return NextResponse.json(
          { error: 'WhatsApp not configured' },
          { status: 400 }
        )
      }
      const accessToken = decrypt(config.access_token)
      driver = createDriver('meta', { phoneNumberId: config.phone_number_id, accessToken })
    }

    // Get the download URL and download the binary data
    const mediaInfo = await driver.getMediaUrl(mediaId)
    const { buffer, contentType } = await driver.downloadMedia(mediaInfo.url)

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': contentType || mediaInfo.mimeType || 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400',
      },
    })
  } catch (error) {
    console.error('Error in WhatsApp media GET:', error)
    return NextResponse.json(
      { error: 'Failed to fetch media' },
      { status: 500 }
    )
  }
}
