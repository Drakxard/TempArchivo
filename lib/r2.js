import {
  S3Client,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24;
export const MAX_FILE_BYTES = 200 * 1024 * 1024;

function getRequiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing ${name}.`);
  }

  return value;
}

function getR2Client() {
  return new S3Client({
    region: "auto",
    endpoint: getRequiredEnv("R2_ENDPOINT"),
    credentials: {
      accessKeyId: getRequiredEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: getRequiredEnv("R2_SECRET_ACCESS_KEY"),
    },
  });
}

function getBucketName() {
  return getRequiredEnv("R2_BUCKET_NAME");
}

function sanitizeExtension(contentType) {
  const extension = contentType.split("/")[1] || "bin";
  return extension.replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin";
}

export function createImageKey(contentType) {
  const extension = sanitizeExtension(contentType);
  return `clipboard/uploads/${Date.now()}-${crypto.randomUUID()}.${extension}`;
}

export function createFileKey(filename, contentType) {
  const filenameExtension = String(filename || "")
    .split(".")
    .pop();
  const extension =
    filenameExtension && filenameExtension !== filename
      ? filenameExtension.replace(/[^a-z0-9]/gi, "").toLowerCase()
      : sanitizeExtension(contentType);

  return `clipboard/uploads/${Date.now()}-${crypto.randomUUID()}.${extension || "bin"}`;
}

export async function createSignedUploadUrl(key, contentType) {
  const client = getR2Client();
  const command = new PutObjectCommand({
    Bucket: getBucketName(),
    Key: key,
    ContentType: contentType,
  });

  return getSignedUrl(client, command, { expiresIn: SIGNED_URL_TTL_SECONDS });
}

export async function uploadR2Object(key, body, contentType) {
  const client = getR2Client();

  await client.send(
    new PutObjectCommand({
      Bucket: getBucketName(),
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

export async function headR2Object(key) {
  const client = getR2Client();
  const response = await client.send(
    new HeadObjectCommand({
      Bucket: getBucketName(),
      Key: key,
    }),
  );

  return {
    contentLength: Number(response.ContentLength || 0),
    contentType: response.ContentType || "application/octet-stream",
  };
}

export async function createSignedReadUrl(key) {
  const client = getR2Client();
  const command = new GetObjectCommand({
    Bucket: getBucketName(),
    Key: key,
  });

  return getSignedUrl(client, command, { expiresIn: SIGNED_URL_TTL_SECONDS });
}

function createAttachmentHeader(filename) {
  const safeFilename = String(filename || "archivo")
    .replace(/[\r\n]/g, "")
    .trim() || "archivo";
  const asciiFilename = safeFilename
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_");
  const encodedFilename = encodeURIComponent(safeFilename).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`;
}

export async function createSignedDownloadUrl(key, filename, contentType) {
  const client = getR2Client();
  const command = new GetObjectCommand({
    Bucket: getBucketName(),
    Key: key,
    ResponseContentDisposition: createAttachmentHeader(filename),
    ResponseContentType: contentType || "application/octet-stream",
  });

  return getSignedUrl(client, command, { expiresIn: SIGNED_URL_TTL_SECONDS });
}

export async function readR2Object(key) {
  const client = getR2Client();
  const command = new GetObjectCommand({
    Bucket: getBucketName(),
    Key: key,
  });
  const response = await client.send(command);
  const body = response.Body;

  if (!body?.transformToByteArray) {
    throw new Error("R2 response body is not readable.");
  }

  return {
    body: await body.transformToByteArray(),
    contentType: response.ContentType || "application/octet-stream",
  };
}

export async function deleteR2Object(key) {
  const client = getR2Client();

  await client.send(
    new DeleteObjectCommand({
      Bucket: getBucketName(),
      Key: key,
    }),
  );
}

export function isR2StorageKey(value) {
  return typeof value === "string" && value.startsWith("clipboard/");
}

export function isUploadStorageKey(value) {
  return typeof value === "string" && value.startsWith("clipboard/uploads/");
}

export async function resolveContentForClient(content) {
  if (
    !content ||
    content.type !== "image" ||
    (!isR2StorageKey(content.value) && content.storage !== "r2")
  ) {
    return content;
  }

  return {
    ...content,
    value: await createSignedReadUrl(content.value),
  };
}
