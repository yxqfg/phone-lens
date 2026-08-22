import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AdmittedImage } from "../types.js";

/** Structural type of the dsh attachment store we consume (docs/dsh-caps.md Q1). */
export interface AttachmentStoreLike {
  saveImages(inputs: ReadonlyArray<{ data: Uint8Array; mediaType: string; name?: string }>): Promise<readonly AdmittedImage["ref"][]>;
}

/** Magic-byte whitelist check — never trust Content-Type alone. */
export function magicMatches(mediaType: string, head: Buffer): boolean {
  if (mediaType === "image/jpeg") return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (mediaType === "image/png") return head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  return false;
}

/**
 * Persist one image through the durable attachment seam.
 * Falls back to a content-addressed file when the dsh attachments service is
 * not mounted (standalone dev / unusual profile), so uploads never vanish.
 */
export async function admitImage(
  input: { data: Uint8Array; mediaType: string; name: string },
  attachments: AttachmentStoreLike | undefined,
  fallbackDir: string,
): Promise<AdmittedImage> {
  if (attachments) {
    const refs = await attachments.saveImages([{ data: input.data, mediaType: input.mediaType, name: input.name }]);
    const ref = refs[0];
    if (!ref) throw new Error("attachment store returned no reference");
    return { ref, storage: "attachments" };
  }
  const ext = input.mediaType === "image/png" ? "png" : "jpg";
  const digest = createHash("sha1").update(input.data).digest("hex").slice(0, 16);
  mkdirSync(fallbackDir, { recursive: true });
  const filePath = join(fallbackDir, `${digest}-${input.name.replace(/[^\w.-]+/g, "_") || "image"}.${ext}`);
  writeFileSync(filePath, input.data);
  return {
    ref: {
      attachmentId: `file:${digest}`,
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 0,
      height: 0,
      name: input.name,
    },
    storage: "file",
    filePath,
  };
}
