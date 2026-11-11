/** Longest side after resizing on the device: plenty for a site photo, small enough for mobile data. */
export const PHOTO_MAX_SIDE = 1600;

/**
 * Resize a picked photo on the device and return a JPEG data URL. Camera photos are 4-12 MB;
 * this usually lands at 200-500 KB. EXIF orientation is applied, and metadata (GPS) is dropped.
 */
export async function resizePhoto(
  file: Blob,
  maxSide = PHOTO_MAX_SIDE,
  quality = 0.82,
): Promise<{ dataUrl: string; width: number; height: number }> {
  if (!/^image\//.test(file.type)) throw new Error('That file is not a photo.');
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This device can’t prepare photos.');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return { dataUrl: canvas.toDataURL('image/jpeg', quality), width, height };
}
