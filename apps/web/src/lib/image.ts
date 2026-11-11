/**
 * Shrinks a picked image on the device before upload: at most 600 px on the long side, PNG if the
 * source has transparency (PNG/SVG/WebP), else JPEG at 0.9. Keeps logos small for PDFs.
 */
export async function resizeLogo(file: File, max = 600): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('That file couldn’t be opened as an image.'));
      i.src = url;
    });
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * k));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * k));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This device can’t prepare images.');
    const opaque = file.type === 'image/jpeg';
    if (opaque) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL(opaque ? 'image/jpeg' : 'image/png', 0.9);
  } finally {
    URL.revokeObjectURL(url);
  }
}
