/**
 * Familista Design Studio — a brand-kit image, made safe (M2c).
 *
 * An uploaded logo is never kept, served or trusted as it arrived. It is:
 *
 *   1. identified by its own first bytes, not by its name or the type the browser declared: PNG or JPEG, and
 *      nothing else (no SVG, which can carry script; no HEIF, GIF, WebP, TIFF or anything a decoder would have to
 *      guess at). A file whose bytes are neither is refused before any decoder sees it;
 *   2. decoded by libvips (sharp) under limits: at most UPLOAD_LIMITS.bytes in, at most UPLOAD_LIMITS.pixels decoded
 *      (a small file that expands into a huge image is refused while its header is read), one frame, and the
 *      decoder's own verdict that the file is whole (failOn: 'error');
 *   3. re-encoded from its pixels alone: the camera orientation applied, scaled to fit OUTPUT_MAX_SIDE without
 *      enlarging, and written as a new PNG with no metadata (no EXIF, ICC profile, text chunks or anything appended
 *      after the image), so whatever else the upload carried — a polyglot, a payload past the end, a comment — is
 *      not in what is kept.
 *
 * The result is what the database stores (DesignBrandAsset.png, whose shape the database checks again) and the only
 * bytes the platform ever serves for that logo.
 */
import { createHash } from 'crypto';
import sharp, { type Metadata, type OutputInfo } from 'sharp';

export const UPLOAD_LIMITS = Object.freeze({
  /** The largest upload accepted, in bytes. */
  bytes: 5 * 1024 * 1024,
  /** The most pixels the decoder will decode (width × height of the upload). */
  pixels: 25_000_000,
  /** The smallest side a logo may have, in pixels. */
  minSide: 16,
});
/** The largest side of the stored PNG, in pixels: enough for a crest printed 170 mm wide at 150 dpi. */
export const OUTPUT_MAX_SIDE = 1024;

export type BrandImageProblem = 'empty' | 'too-large' | 'unsupported-type' | 'unreadable' | 'too-many-pixels' | 'too-small' | 'animated';

export class BrandImageError extends Error {
  readonly code: BrandImageProblem;
  constructor(code: BrandImageProblem) {
    super(`The image was refused: ${code}`);
    this.name = 'BrandImageError';
    this.code = code;
  }
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);

/** What the bytes say they are: 'png', 'jpeg', or null. */
export function sniff(input: Buffer): 'png' | 'jpeg' | null {
  if (input.length >= PNG.length && input.subarray(0, PNG.length).equals(PNG)) return 'png';
  if (input.length >= JPEG.length && input.subarray(0, JPEG.length).equals(JPEG)) return 'jpeg';
  return null;
}

export interface SafeImage {
  png: Buffer;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
}

/** The upload, decoded and re-encoded as a clean PNG, or a BrandImageError saying why not. */
export async function normaliseBrandImage(input: Buffer): Promise<SafeImage> {
  if (!Buffer.isBuffer(input) || input.length === 0) throw new BrandImageError('empty');
  if (input.length > UPLOAD_LIMITS.bytes) throw new BrandImageError('too-large');
  const kind = sniff(input);
  if (!kind) throw new BrandImageError('unsupported-type');

  const options = { limitInputPixels: UPLOAD_LIMITS.pixels, failOn: 'error' as const, pages: 1 };
  let meta: Metadata;
  try {
    meta = await sharp(input, options).metadata();
  } catch (err) {
    throw new BrandImageError(/pixel limit/i.test(String((err as Error)?.message)) ? 'too-many-pixels' : 'unreadable');
  }
  // The decoder must agree with the bytes: a PNG signature on a file libvips reads as something else is refused.
  if (meta.format !== kind) throw new BrandImageError('unsupported-type');
  if ((meta.pages ?? 1) > 1) throw new BrandImageError('animated');
  const w = meta.width ?? 0, h = meta.height ?? 0;
  if (!w || !h) throw new BrandImageError('unreadable');
  if (w * h > UPLOAD_LIMITS.pixels) throw new BrandImageError('too-many-pixels');
  if (Math.min(w, h) < UPLOAD_LIMITS.minSide) throw new BrandImageError('too-small');

  let out: { data: Buffer; info: OutputInfo };
  try {
    out = await sharp(input, options)
      .rotate()
      .resize({ width: OUTPUT_MAX_SIDE, height: OUTPUT_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer({ resolveWithObject: true });
  } catch (err) {
    throw new BrandImageError(/pixel limit/i.test(String((err as Error)?.message)) ? 'too-many-pixels' : 'unreadable');
  }
  return {
    png: out.data,
    width: out.info.width,
    height: out.info.height,
    bytes: out.data.length,
    sha256: createHash('sha256').update(out.data).digest('hex'),
  };
}
