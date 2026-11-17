// Prepares user images for assistant_send: downscale, re-encode, base64.

export const MAX_IMAGES = 8;
const MAX_EDGE = 1568;
/** Base64 length limit enforced by the backend. */
const MAX_B64 = 5 * 1024 * 1024;
const TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const IMAGE_ACCEPT = TYPES.join(",");

export type PreparedImage = {
  name: string;
  mediaType: string;
  /** Base64 without the data: prefix. */
  data: string;
  /** Object URL for thumbnails; revoke with revokeImage. */
  previewUrl: string;
};

const EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** MIME type of an image file (falls back to the extension), else null. */
export function imageType(f: File): string | null {
  if (TYPES.includes(f.type)) return f.type;
  if (f.type && !f.type.startsWith("image/")) return null;
  const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
  return EXT[ext] ?? null;
}

export function isImageFile(f: File) {
  return imageType(f) !== null;
}

export function revokeImage(img: { previewUrl: string }) {
  URL.revokeObjectURL(img.previewUrl);
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function b64Len(bytes: number) {
  return Math.ceil(bytes / 3) * 4;
}

function canvasBlob(c: HTMLCanvasElement, type: string, q?: number) {
  return new Promise<Blob | null>((res) => c.toBlob(res, type, q));
}

/** Throws a user-presentable Error. */
export async function prepareImage(
  file: File,
  name: string,
): Promise<PreparedImage> {
  const type = imageType(file);
  if (!type) throw new Error(`${file.name || "File"} is not a supported image.`);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`${file.name || "Image"} could not be read.`);
  }
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const resized = scale < 1;
    let blob: Blob = file;
    let mediaType = type;
    // GIF and WebP pass through when small and not resized.
    const passThrough =
      !resized && b64Len(file.size) <= MAX_B64 && type !== "image/webp";
    if (!passThrough) {
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(bitmap.width * scale));
      c.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = c.getContext("2d");
      if (!ctx) throw new Error("Canvas is not available.");
      const lossy = type === "image/jpeg";
      if (lossy) {
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, c.width, c.height);
      }
      ctx.drawImage(bitmap, 0, 0, c.width, c.height);
      // GIFs become a PNG of the first frame; WebP becomes PNG too.
      let out = await canvasBlob(c, lossy ? "image/jpeg" : "image/png", 0.85);
      mediaType = lossy ? "image/jpeg" : "image/png";
      if (out && b64Len(out.size) > MAX_B64 && !lossy) {
        const bg = document.createElement("canvas");
        bg.width = c.width;
        bg.height = c.height;
        const bctx = bg.getContext("2d")!;
        bctx.fillStyle = "#fff";
        bctx.fillRect(0, 0, bg.width, bg.height);
        bctx.drawImage(c, 0, 0);
        out = await canvasBlob(bg, "image/jpeg", 0.85);
        mediaType = "image/jpeg";
      }
      if (!out || b64Len(out.size) > MAX_B64)
        throw new Error(`${file.name || "Image"} is too large.`);
      blob = out;
    }
    return {
      name,
      mediaType,
      data: await toBase64(blob),
      previewUrl: URL.createObjectURL(blob),
    };
  } finally {
    bitmap.close();
  }
}
