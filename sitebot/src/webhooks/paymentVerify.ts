import crypto from "node:crypto";

function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Verify Pay with Locus Checkout webhook (`x-signature-256: sha256=...`) */
export function verifyPayWithLocusSignature(
  rawBodyUtf8: string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(rawBodyUtf8, "utf8").digest("hex")}`;
  return timingSafeEqualStr(expected, signatureHeader);
}

/** Alternate header name / hex-only signature (hackathon / custom stacks) */
export function verifyLocusAlternateSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const h = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const hdr = signatureHeader.trim();
  if (timingSafeEqualStr(h, hdr)) return true;
  if (hdr.startsWith("sha256=") && timingSafeEqualStr(h, hdr.slice("sha256=".length))) return true;
  return false;
}

export function verifyWebhookSignature(
  rawBody: Buffer,
  headers: NodeJS.Dict<string | string[] | undefined>,
  secret: string | undefined,
): boolean {
  if (!secret) return false;
  const rawUtf8 = rawBody.toString("utf8");
  const sig256 = headers["x-signature-256"];
  const sig256s = Array.isArray(sig256) ? sig256[0] : sig256;
  if (sig256s && verifyPayWithLocusSignature(rawUtf8, sig256s, secret)) return true;

  const loc = headers["x-locus-signature"];
  const locs = Array.isArray(loc) ? loc[0] : loc;
  if (locs && verifyLocusAlternateSignature(rawBody, locs, secret)) return true;

  return false;
}
