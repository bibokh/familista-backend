/**
 * Design Studio, M2c — a brand-kit image, made safe (src/platform/product-design/brand-image.ts).
 *
 * An upload is kept only as the PNG the server re-encodes from its pixels. Pinned here, on real images made with the
 * same decoder, each refusal beside the acceptance it mirrors (the negative controls):
 *   · PNG and JPEG are accepted, by their bytes; SVG, GIF, a renamed text file and a lying signature are refused
 *     before or by the decoder;
 *   · what is kept is a new PNG: no EXIF, nothing appended after the image survives, the camera orientation is applied,
 *     the size is capped at 1024 px a side without enlarging;
 *   · limits: empty, over 5 MB, a decompression bomb over 25 megapixels (a small file), and a logo under 16 px a side.
 */
import sharp, { type Sharp } from 'sharp';
import { BrandImageError, normaliseBrandImage, OUTPUT_MAX_SIDE, sniff, UPLOAD_LIMITS } from '../src/platform/product-design/brand-image';

const solid = (w: number, h: number, format: 'png' | 'jpeg', extra?: (s: Sharp) => Sharp) => {
  let s = sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 30, b: 40 } } });
  if (extra) s = extra(s);
  return (format === 'png' ? s.png() : s.jpeg({ quality: 90 })).toBuffer();
};
const refused = async (input: Buffer) => {
  try { await normaliseBrandImage(input); return null; } catch (e) { return e instanceof BrandImageError ? e.code : `other: ${(e as Error).message}`; }
};
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('what is accepted, by its bytes', () => {
  it('a PNG and a JPEG are kept as a new PNG, with its size and its SHA-256', async () => {
    for (const fmt of ['png', 'jpeg'] as const) {
      const out = await normaliseBrandImage(await solid(300, 200, fmt));
      expect(out.png.subarray(0, 8).equals(PNG_SIG)).toBe(true);
      expect([out.width, out.height, out.bytes]).toEqual([300, 200, out.png.length]);
      expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect((await sharp(out.png).metadata()).format).toBe('png');
    }
  });

  it('sniffs the signature, not the name or the declared type', () => {
    expect(sniff(Buffer.concat([PNG_SIG, Buffer.from('rest')]))).toBe('png');
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniff(Buffer.from('GIF89a'))).toBeNull();
  });

  it('refuses SVG, GIF and text before any decoder runs (negative controls for the formats above)', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>');
    const gif = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#000' } }).gif().toBuffer();
    expect(await refused(svg)).toBe('unsupported-type');
    expect(await refused(gif)).toBe('unsupported-type');
    expect(await refused(Buffer.from('just text, named logo.png'))).toBe('unsupported-type');
  });

  it('refuses a lying signature: a PNG header over bytes that are not a PNG, and a JPEG header on a PNG', async () => {
    expect(await refused(Buffer.concat([PNG_SIG, Buffer.from('this is not an image at all, whatever its header says')]))).toBe('unreadable');
    const png = await solid(64, 64, 'png');
    expect(await refused(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), png]))).not.toBeNull();
  });
});

describe('what is kept is the pixels, and nothing else', () => {
  it('drops EXIF and other metadata', async () => {
    const withExif = await solid(200, 120, 'jpeg', (s) => s.withMetadata({ exif: { IFD0: { Copyright: 'secret-marker', Artist: 'someone' } } }));
    expect((await sharp(withExif).metadata()).exif).toBeDefined(); // negative control: the upload carried it
    const out = await normaliseBrandImage(withExif);
    const meta = await sharp(out.png).metadata();
    expect(meta.exif).toBeUndefined();
    expect(out.png.includes(Buffer.from('secret-marker'))).toBe(false);
  });

  it('keeps nothing appended after the image (a polyglot: a valid PNG with a script and an archive after it)', async () => {
    const png = await solid(64, 64, 'png');
    const payload = Buffer.from('<script>alert(document.cookie)</script>PK\u0003\u0004payload-marker');
    const polyglot = Buffer.concat([png, payload]);
    const out = await normaliseBrandImage(polyglot);
    expect(polyglot.includes(Buffer.from('payload-marker'))).toBe(true); // negative control
    expect(out.png.includes(Buffer.from('payload-marker'))).toBe(false);
    expect(out.png.includes(Buffer.from('<script>'))).toBe(false);
  });

  it('applies the camera orientation, and caps the size at 1024 px a side without enlarging', async () => {
    const rotated = await solid(400, 100, 'jpeg', (s) => s.withMetadata({ orientation: 6 }));
    const r = await normaliseBrandImage(rotated);
    expect([r.width, r.height]).toEqual([100, 400]);
    const big = await normaliseBrandImage(await solid(3000, 1000, 'png'));
    expect([big.width, big.height]).toEqual([OUTPUT_MAX_SIDE, 341]);
    const small = await normaliseBrandImage(await solid(40, 40, 'png'));
    expect([small.width, small.height]).toEqual([40, 40]);
  });
});

describe('limits', () => {
  it('refuses an empty upload and one over the size limit', async () => {
    expect(await refused(Buffer.alloc(0))).toBe('empty');
    expect(await refused(Buffer.concat([PNG_SIG, Buffer.alloc(UPLOAD_LIMITS.bytes)]))).toBe('too-large');
  });

  it('refuses a decompression bomb: a small file that would decode to more than 25 megapixels', async () => {
    const bomb = await sharp({ create: { width: 6000, height: 6000, channels: 3, background: '#000' } }).png({ compressionLevel: 9 }).toBuffer();
    expect(bomb.length).toBeLessThan(UPLOAD_LIMITS.bytes); // small on disk, 36 MP decoded
    expect(await refused(bomb)).toBe('too-many-pixels');
    // negative control: just under the limit is accepted
    expect(await refused(await sharp({ create: { width: 5000, height: 4999, channels: 3, background: '#000' } }).png({ compressionLevel: 9 }).toBuffer())).toBeNull();
  }, 60_000);

  it('refuses a logo too small to print, and accepts the smallest that is not', async () => {
    expect(await refused(await solid(15, 64, 'png'))).toBe('too-small');
    expect(await refused(await solid(16, 64, 'png'))).toBeNull();
  });
});
