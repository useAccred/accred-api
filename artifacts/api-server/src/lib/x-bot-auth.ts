import { createHash, timingSafeEqual } from "node:crypto";

function tokenDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Compare fixed-width digests so timingSafeEqual does not disclose token length.
 * The caller must still treat a missing configured token as service failure.
 */
export function hasValidXBotServiceAuthorization(
  authorizationHeader: string | undefined,
  expectedToken: string | undefined,
): boolean {
  const match = authorizationHeader?.match(/^Bearer\s+([^\s]+)$/i);
  const presented = match?.[1] ?? "";
  const expected = expectedToken ?? "";
  const equal = timingSafeEqual(tokenDigest(presented), tokenDigest(expected));
  return Boolean(match && expectedToken && equal);
}