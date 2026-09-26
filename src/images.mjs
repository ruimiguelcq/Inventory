import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

// One image per product, stored as a file and served by its own application route.
export const IMAGE_TYPES = [
  { extension: 'jpg', mimeType: 'image/jpeg' },
  { extension: 'png', mimeType: 'image/png' },
  { extension: 'webp', mimeType: 'image/webp' },
];

export function imageDirectoryFor(databasePath) {
  return process.env.IMAGES_DIRECTORY ?? join(dirname(databasePath), 'images');
}

// The declared content type is only a hint; the leading bytes decide the real format.
function detectExtension(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function extensionOf(name) {
  return extname(name).slice(1).toLowerCase();
}

function mimeTypeFor(extension) {
  return IMAGE_TYPES.find((type) => type.extension === extension)?.mimeType ?? null;
}

// Reads a multipart file field: returns the accepted image, no image, or a clear rejection.
export async function readImageUpload(value) {
  if (!value || typeof value === 'string' || typeof value.arrayBuffer !== 'function' || !value.size) return { image: null };
  if (value.size > MAX_IMAGE_BYTES) return { error: 'La imagen supera el límite de 2 MB.' };
  const bytes = Buffer.from(await value.arrayBuffer());
  const extension = detectExtension(bytes);
  if (!extension) return { error: 'Formato de imagen no admitido. Usa JPG, PNG o WEBP.' };
  return { image: { bytes, extension } };
}

export function storeProductImage(directory, productId, image) {
  mkdirSync(directory, { recursive: true });
  const filename = `${productId}-${randomBytes(8).toString('hex')}.${image.extension}`;
  writeFileSync(join(directory, filename), image.bytes);
  return filename;
}

export function removeProductImage(directory, filename) {
  if (!directory || !filename) return;
  rmSync(join(directory, basename(String(filename))), { force: true });
}

export function readProductImage(directory, filename) {
  if (!filename) return null;
  const safe = basename(String(filename));
  const path = join(directory, safe);
  if (!existsSync(path)) return null;
  const mimeType = mimeTypeFor(extensionOf(safe));
  if (!mimeType) return null;
  return { bytes: readFileSync(path), mimeType };
}

// Backups and restores carry the image folder alongside the database snapshot.
export function countImages(directory) {
  if (!directory || !existsSync(directory)) return 0;
  return readdirSync(directory).filter((name) => mimeTypeFor(extensionOf(name))).length;
}
