/**
 * LDI packet framing (spec, "Packet Protocol").
 *
 * ```
 *  STX  | L1 L2  |            Message            | BCC | ETX
 * (0x02)| 2 bytes| 6 to 507 bytes before stuffing |1 by.|(0x03)
 * ```
 *
 * ACK, NAK and SNAK are not packets: they are exactly two bytes, the control
 * character followed by ETX.
 */

import { computeBcc, computeBccFromParts, encodeLengthBytes } from './bcc.js';
import { ByteStuffingError, stuff, unstuff } from './byte-stuffing.js';
import {
  ControlCharacter,
  MAX_MESSAGE_LENGTH,
  MIN_MESSAGE_LENGTH,
} from './constants.js';

/** Two-byte responses that are not packets (spec Table 1). */
export const ACK_RESPONSE = Buffer.from([ControlCharacter.ACK, ControlCharacter.ETX]);
export const NAK_RESPONSE = Buffer.from([ControlCharacter.NAK, ControlCharacter.ETX]);
export const SNAK_RESPONSE = Buffer.from([ControlCharacter.SNAK, ControlCharacter.ETX]);

/** Reasons a received packet was rejected. */
export type PacketErrorReason =
  /** Declared L1/L2 did not match the number of unstuffed message bytes. */
  | 'length'
  /** BCC did not match the sum over the length bytes and the message. */
  | 'checksum'
  /** The stuffed byte stream contained an undefined escape sequence. */
  | 'stuffing'
  /** Too few bytes between STX and ETX to contain a length field and a BCC. */
  | 'truncated';

/** A well-formed packet whose length and checksum both verified. */
export interface PacketEvent {
  kind: 'packet';
  /** Unstuffed message bytes (spec Figure 4). */
  message: Buffer;
  /** The packet exactly as it arrived on the wire, STX and ETX included. */
  raw: Buffer;
}

/** An ACK, NAK or SNAK response followed by its mandatory ETX. */
export interface ResponseEvent {
  kind: 'ack' | 'nak' | 'snak';
  raw: Buffer;
}

/** A packet that arrived intact but failed validation; the caller should NAK. */
export interface PacketErrorEvent {
  kind: 'error';
  reason: PacketErrorReason;
  message: string;
  raw: Buffer;
}

/**
 * Bytes dropped because they were not part of any packet.
 *
 * The drive emits a self-test byte sequence before power-on-reset completes.
 * The spec requires the receiver to discard everything ahead of an STX, which
 * is what produces these events; they are informational only.
 */
export interface DiscardedEvent {
  kind: 'discarded';
  raw: Buffer;
}

export type DecodedEvent = PacketEvent | ResponseEvent | PacketErrorEvent | DiscardedEvent;

/** Options for {@link encodePacket}. */
export interface EncodePacketOptions {
  /**
   * Skips the 6..507 byte message-length check. Only useful for building the
   * deliberately malformed packets used in tests.
   */
  allowInvalidLength?: boolean;
}

/**
 * Wraps a message in a complete, byte-stuffed packet ready for the wire.
 *
 * @param message Unstuffed message bytes (spec Figure 4).
 */
export function encodePacket(message: Uint8Array, options: EncodePacketOptions = {}): Buffer {
  if (!options.allowInvalidLength) {
    if (message.length < MIN_MESSAGE_LENGTH || message.length > MAX_MESSAGE_LENGTH) {
      throw new RangeError(
        `message length ${message.length} is outside the legal range of ` +
          `${MIN_MESSAGE_LENGTH}..${MAX_MESSAGE_LENGTH} bytes`,
      );
    }
  }

  const [l1, l2] = encodeLengthBytes(message.length);
  const bcc = computeBcc(message);

  // Stuff the length bytes, the message and the BCC as one span. The spec's
  // "Byte Stuffing" section names all three as subject to stuffing and promises
  // that "there will never be a 0x02 or 0x03 in the packet except for an STX
  // and ETX" - a promise that only holds if the BCC is stuffed as well. (The
  // later "Sending Packets" and "Receiving Packets" rules mention only the
  // length and message bytes; stuffing the BCC too is the reading that keeps a
  // BCC of 0x03 from being mistaken for the closing ETX.)
  const stuffed = stuff(Buffer.concat([Buffer.from([l1, l2]), Buffer.from(message), Buffer.from([bcc])]));

  return Buffer.concat([
    Buffer.from([ControlCharacter.STX]),
    stuffed,
    Buffer.from([ControlCharacter.ETX]),
  ]);
}

/**
 * Validates and unpacks the bytes between an STX and its ETX.
 *
 * @param body Stuffed bytes strictly between STX and ETX.
 * @param raw The full packet including STX and ETX, used for reporting.
 */
function decodePacketBody(body: Buffer, raw: Buffer): PacketEvent | PacketErrorEvent {
  let unstuffed: Buffer;
  try {
    unstuffed = unstuff(body);
  } catch (error) {
    return {
      kind: 'error',
      reason: 'stuffing',
      message: error instanceof ByteStuffingError ? error.message : String(error),
      raw,
    };
  }

  // Two length bytes plus at least one BCC byte.
  if (unstuffed.length < 3) {
    return {
      kind: 'error',
      reason: 'truncated',
      message: `packet carries ${unstuffed.length} unstuffed bytes, need at least 3`,
      raw,
    };
  }

  const l1 = unstuffed[0]!;
  const l2 = unstuffed[1]!;
  const declaredLength = (l1 << 8) | l2;
  const actualLength = unstuffed.length - 3;

  if (declaredLength !== actualLength) {
    return {
      kind: 'error',
      reason: 'length',
      message: `length field declares ${declaredLength} message bytes but the packet carries ${actualLength}`,
      raw,
    };
  }

  const message = unstuffed.subarray(2, 2 + declaredLength);
  const receivedBcc = unstuffed[unstuffed.length - 1]!;
  const expectedBcc = computeBccFromParts(l1, l2, message);

  if (receivedBcc !== expectedBcc) {
    return {
      kind: 'error',
      reason: 'checksum',
      message:
        `BCC mismatch: packet carries 0x${receivedBcc.toString(16).padStart(2, '0').toUpperCase()}, ` +
        `computed 0x${expectedBcc.toString(16).padStart(2, '0').toUpperCase()}`,
      raw,
    };
  }

  return { kind: 'packet', message: Buffer.from(message), raw };
}

/**
 * Decodes a single complete packet.
 *
 * @param packet A buffer starting with STX and ending with ETX.
 * @throws {Error} If the buffer is not framed by STX and ETX. Framing errors
 * are the decoder's business; use {@link PacketDecoder} for stream input.
 */
export function decodePacket(packet: Buffer): PacketEvent | PacketErrorEvent {
  if (packet.length < 2 || packet[0] !== ControlCharacter.STX) {
    throw new Error('packet does not start with STX (0x02)');
  }
  if (packet[packet.length - 1] !== ControlCharacter.ETX) {
    throw new Error('packet does not end with ETX (0x03)');
  }
  return decodePacketBody(packet.subarray(1, packet.length - 1), packet);
}

/** Internal decoder states. */
const enum State {
  /** Between packets: waiting for STX, or for an ACK/NAK/SNAK. */
  Idle,
  /** Inside a packet: collecting stuffed bytes until ETX. */
  InPacket,
  /** An ACK/NAK/SNAK arrived and its mandatory trailing ETX is expected next. */
  AwaitingResponseEtx,
}

/**
 * Streaming packet decoder.
 *
 * Implements the receive rules from the spec:
 *
 * - characters ahead of an STX are ignored, except ACK, NAK and SNAK;
 * - ACK, NAK and SNAK must be immediately followed by an ETX;
 * - after the closing ETX the length and message bytes are unstuffed and the
 *   BCC is checked; a bad length or BCC means the caller should reply NAK.
 *
 * Because a stuffed packet can never contain 0x02 or 0x03, framing on STX and
 * ETX is unambiguous.
 */
export class PacketDecoder {
  private state: State = State.Idle;
  private buffer: number[] = [];
  private discarded: number[] = [];
  private pendingResponse: 'ack' | 'nak' | 'snak' | null = null;

  /**
   * Feeds received bytes into the decoder.
   *
   * @returns Every event completed by this chunk, in arrival order.
   */
  push(chunk: Uint8Array): DecodedEvent[] {
    const events: DecodedEvent[] = [];

    for (const byte of chunk) {
      switch (this.state) {
        case State.Idle:
          this.handleIdleByte(byte, events);
          break;

        case State.AwaitingResponseEtx:
          if (byte === ControlCharacter.ETX) {
            events.push({
              kind: this.pendingResponse!,
              raw: Buffer.from([this.responseByte(this.pendingResponse!), ControlCharacter.ETX]),
            });
            this.pendingResponse = null;
            this.state = State.Idle;
          } else {
            // Not a well-formed response; the leading control character is
            // noise, so drop it and re-interpret this byte from Idle.
            this.discarded.push(this.responseByte(this.pendingResponse!));
            this.pendingResponse = null;
            this.state = State.Idle;
            this.handleIdleByte(byte, events);
          }
          break;

        case State.InPacket:
          if (byte === ControlCharacter.ETX) {
            const body = Buffer.from(this.buffer);
            const raw = Buffer.concat([
              Buffer.from([ControlCharacter.STX]),
              body,
              Buffer.from([ControlCharacter.ETX]),
            ]);
            this.buffer = [];
            this.state = State.Idle;
            events.push(decodePacketBody(body, raw));
          } else if (byte === ControlCharacter.STX) {
            // A fresh STX inside a packet means the previous one was partial:
            // stuffing guarantees a real 0x02 can only be an STX. Resynchronise
            // on it and keep the new packet, following the spec's rule that all
            // characters preceding an STX are ignored.
            //
            // The spec also notes that a partial packet prepended to a full one
            // "will result in a NAK ... due to an apparent mismatch of the L1,
            // L2 length indication with the total (combined) message length".
            // That outcome belongs to the other framing strategy the spec
            // permits, where packets are delineated by searching for ETX alone
            // and the stale header is therefore read as the packet's own.
            // Resynchronising is the more forgiving of the two: the sender gets
            // an ACK for a packet that did arrive intact instead of being made
            // to retransmit it.
            this.discarded.push(ControlCharacter.STX, ...this.buffer);
            this.flushDiscarded(events);
            this.buffer = [];
          } else {
            this.buffer.push(byte);
          }
          break;
      }
    }

    // Report bytes dropped outside of any packet once the chunk is consumed.
    this.flushDiscarded(events);
    return events;
  }

  /** Drops any partially received packet and returns the decoder to Idle. */
  reset(): void {
    this.state = State.Idle;
    this.buffer = [];
    this.discarded = [];
    this.pendingResponse = null;
  }

  private handleIdleByte(byte: number, events: DecodedEvent[]): void {
    switch (byte) {
      case ControlCharacter.STX:
        this.flushDiscarded(events);
        this.state = State.InPacket;
        this.buffer = [];
        break;
      case ControlCharacter.ACK:
        this.flushDiscarded(events);
        this.pendingResponse = 'ack';
        this.state = State.AwaitingResponseEtx;
        break;
      case ControlCharacter.NAK:
        this.flushDiscarded(events);
        this.pendingResponse = 'nak';
        this.state = State.AwaitingResponseEtx;
        break;
      case ControlCharacter.SNAK:
        this.flushDiscarded(events);
        this.pendingResponse = 'snak';
        this.state = State.AwaitingResponseEtx;
        break;
      default:
        this.discarded.push(byte);
    }
  }

  private flushDiscarded(events: DecodedEvent[]): void {
    if (this.discarded.length > 0) {
      events.push({ kind: 'discarded', raw: Buffer.from(this.discarded) });
      this.discarded = [];
    }
  }

  private responseByte(kind: 'ack' | 'nak' | 'snak'): number {
    switch (kind) {
      case 'ack':
        return ControlCharacter.ACK;
      case 'nak':
        return ControlCharacter.NAK;
      case 'snak':
        return ControlCharacter.SNAK;
    }
  }
}
