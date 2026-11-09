import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export function openR2Evidence(env, key) {
  const client = new S3Client({
    region: 'auto',
    endpoint: env.R2_ENDPOINT,
    // Keep signed browser uploads on the exact origin allowed by our CSP.
    forcePathStyle: true,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const object = (value) => ({ Bucket: env.R2_BUCKET, Key: key(value) });
  return {
    cloud: true,
    read: async (value) => {
      try {
        const result = await client.send(new GetObjectCommand(object(value)));
        // Photos are bounded at 12 MB; PDF reports are capped separately.
        if (result.ContentLength > (key(value).startsWith('reports/') ? 120 : 12) * 1024 * 1024) {
          result.Body.destroy();
          throw new Error('Evidence exceeds size limit');
        }
        return Buffer.from(await result.Body.transformToByteArray());
      } catch (error) {
        if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404)
          error.code = 'ENOENT';
        throw error;
      }
    },
    put: async (value, bytes, contentType = 'application/octet-stream') => {
      try {
        await client.send(
          new PutObjectCommand({
            ...object(value),
            Body: bytes,
            ContentType: contentType,
            IfNoneMatch: '*',
            CacheControl: 'private, no-store',
          }),
        );
      } catch (error) {
        if (error.$metadata?.httpStatusCode === 412) error.code = 'EEXIST';
        throw error;
      }
    },
    remove: (value) => client.send(new DeleteObjectCommand(object(value))),
    signedRead: (value, download) =>
      getSignedUrl(
        client,
        new GetObjectCommand({
          ...object(value),
          ResponseCacheControl: 'private, no-store',
          ...(download
            ? {
                ResponseContentDisposition: `attachment; filename="${download.replace(/[^a-zA-Z0-9_.-]/g, '_')}"`,
              }
            : {}),
        }),
        { expiresIn: 120 },
      ),
    signedUpload: (value, bytes) =>
      getSignedUrl(
        client,
        new PutObjectCommand({
          ...object(value),
          ContentLength: bytes,
          IfNoneMatch: '*',
          ContentType: 'application/octet-stream',
        }),
        { expiresIn: 600, signableHeaders: new Set(['content-length', 'if-none-match']) },
      ),
    uploadHeaders: { 'Content-Type': 'application/octet-stream', 'If-None-Match': '*' },
    uploadSeconds: 600,
  };
}
