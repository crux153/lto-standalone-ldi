/**
 * Byte stuffing for the LDI packet protocol (spec, "Byte Stuffing").
 *
 * Stuffing guarantees that the only 0x02 and 0x03 bytes on the wire are the
 * real STX and ETX framing characters:
 *
 * | transmitted as | for the byte |
 * | -------------- | ------------ |
 * | 0xFF 0xF2      | 0x02         |
 * | 0xFF 0xF3      | 0x03         |
 * | 0xFF 0xFF      | 0xFF         |
 *
 * Stuffing happens *after* the length bytes and the block-check character have
 * been computed, and unstuffing happens before either is validated, so neither
 * calculation is affected by it.
 */

import { ControlCharacter } from './constants.js';

/** Escape byte that introduces a two-byte stuffed sequence. */
const ESCAPE = 0xff;

/** Second byte of the sequence that stands for STX (0x02). */
const ESCAPED_STX = 0xf2;

/** Second byte of the sequence that stands for ETX (0x03). */
const ESCAPED_ETX = 0xf3;

/** Second byte of the sequence that stands for a literal 0xFF. */
const ESCAPED_ESCAPE = 0xff;

/** Thrown when a stuffed byte stream cannot be decoded. */
export class ByteStuffingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ByteStuffingError';
  }
}

/**
 * Applies byte stuffing to `data`.
 *
 * @param data Raw bytes to escape (length bytes, message and BCC).
 * @returns A new buffer in which no byte equals STX (0x02) or ETX (0x03).
 */
export function stuff(data: Uint8Array): Buffer {
  // Worst case every input byte expands to two bytes.
  const out = Buffer.allocUnsafe(data.length * 2);
  let n = 0;

  for (const byte of data) {
    switch (byte) {
      case ControlCharacter.STX:
        out[n++] = ESCAPE;
        out[n++] = ESCAPED_STX;
        break;
      case ControlCharacter.ETX:
        out[n++] = ESCAPE;
        out[n++] = ESCAPED_ETX;
        break;
      case ESCAPE:
        out[n++] = ESCAPE;
        out[n++] = ESCAPED_ESCAPE;
        break;
      default:
        out[n++] = byte;
    }
  }

  return out.subarray(0, n);
}

/**
 * Reverses {@link stuff}.
 *
 * @param data Stuffed bytes, without the surrounding STX/ETX.
 * @returns The original unstuffed bytes.
 * @throws {ByteStuffingError} If an escape byte is dangling or is followed by a
 * value other than 0xF2, 0xF3 or 0xFF. The spec calls this sequence undefined
 * and tells the receiver to answer with a NAK.
 */
export function unstuff(data: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(data.length);
  let n = 0;

  for (let i = 0; i < data.length; i++) {
    const byte = data[i]!;

    if (byte !== ESCAPE) {
      out[n++] = byte;
      continue;
    }

    const next = data[i + 1];
    if (next === undefined) {
      throw new ByteStuffingError(
        `dangling escape byte 0xFF at offset ${i} with no following byte`,
      );
    }

    switch (next) {
      case ESCAPED_STX:
        out[n++] = ControlCharacter.STX;
        break;
      case ESCAPED_ETX:
        out[n++] = ControlCharacter.ETX;
        break;
      case ESCAPED_ESCAPE:
        out[n++] = ESCAPE;
        break;
      default:
        throw new ByteStuffingError(
          `undefined escape sequence 0xFF 0x${next.toString(16).padStart(2, '0').toUpperCase()} at offset ${i}`,
        );
    }
    i++;
  }

  return out.subarray(0, n);
}
