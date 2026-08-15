/**
 * Block-check character (BCC) computation (spec, "Packet Protocol").
 *
 * The spec defines the BCC as:
 *
 * - treat each byte as an integer between 0 and 255;
 * - add the bytes, beginning with (and including) the length bytes L1 and L2
 *   and ending with (and including) the last byte of the message;
 * - use the low-order byte of that sum (STX, ETX and the BCC itself are not
 *   part of the sum).
 *
 * The bytes summed are the *unstuffed* ones: byte stuffing is applied only
 * after the BCC has been calculated, and is undone before it is verified.
 */

/**
 * Encodes a message length as the two-byte L1/L2 field, high-order byte first.
 *
 * @param length Number of message bytes before byte stuffing.
 */
export function encodeLengthBytes(length: number): [l1: number, l2: number] {
  if (!Number.isInteger(length) || length < 0 || length > 0xffff) {
    throw new RangeError(`message length ${length} does not fit in two bytes`);
  }
  return [(length >>> 8) & 0xff, length & 0xff];
}

/**
 * Computes the BCC over an explicit length field and message body.
 *
 * Kept separate from {@link computeBcc} so a receiver can verify a packet using
 * the length bytes that actually arrived rather than a re-derived value.
 */
export function computeBccFromParts(l1: number, l2: number, message: Uint8Array): number {
  let sum = l1 + l2;
  for (const byte of message) {
    sum += byte;
  }
  return sum & 0xff;
}

/**
 * Computes the BCC for a message, deriving L1/L2 from its length.
 *
 * @param message Unstuffed message bytes.
 */
export function computeBcc(message: Uint8Array): number {
  const [l1, l2] = encodeLengthBytes(message.length);
  return computeBccFromParts(l1, l2, message);
}
