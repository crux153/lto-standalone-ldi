/**
 * The message header common to every LDI message (spec Figure 4).
 *
 * ```
 * byte 0     Msg Type
 * byte 1     Tgt Addr
 * bytes 2-5  Msg ID
 * bytes 6+   Message Data
 * ```
 */

import { MESSAGE_HEADER_LENGTH } from '../constants.js';

/** Length of the Msg ID field, in bytes. */
export const MSG_ID_LENGTH = 4;

/** The header fields carried by every LDI message. */
export interface MessageHeader {
  /** Byte 0: message type, one of {@link MessageType}. */
  msgType: number;
  /**
   * Byte 1: LDI address of the intended target. 0xFF addresses the library;
   * 0x01..0xFE address a drive.
   */
  tgtAddr: number;
  /**
   * Bytes 2..5: message identifier. Byte 0 of this field is the LDI address of
   * the message's originator; the remaining three bytes are a key chosen by
   * that originator. A response must echo all four bytes unchanged.
   */
  msgId: Buffer;
}

/** Thrown when a received message cannot be parsed. */
export class MessageParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessageParseError';
  }
}

/** Serialises a {@link MessageHeader} into the first six message bytes. */
export function encodeHeader(header: MessageHeader): Buffer {
  const msgId = Buffer.from(header.msgId);
  if (msgId.length !== MSG_ID_LENGTH) {
    throw new RangeError(`Msg ID must be exactly ${MSG_ID_LENGTH} bytes, received ${msgId.length}`);
  }
  assertByte(header.msgType, 'Msg Type');
  assertByte(header.tgtAddr, 'Tgt Addr');

  return Buffer.concat([Buffer.from([header.msgType, header.tgtAddr]), msgId]);
}

/** Reads the header out of a message body. */
export function parseHeader(message: Uint8Array): MessageHeader {
  if (message.length < MESSAGE_HEADER_LENGTH) {
    throw new MessageParseError(
      `message is ${message.length} bytes, too short to contain the ${MESSAGE_HEADER_LENGTH}-byte header`,
    );
  }
  return {
    msgType: message[0]!,
    tgtAddr: message[1]!,
    msgId: Buffer.from(message.subarray(2, 2 + MSG_ID_LENGTH)),
  };
}

/** Byte 6 of a Two_Way message: the message subtype, or undefined if absent. */
export function readSubtype(message: Uint8Array): number | undefined {
  return message[MESSAGE_HEADER_LENGTH];
}

/** Throws unless `value` is an integer in 0..255. */
export function assertByte(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError(`${field} must be an integer in 0..255, received ${value}`);
  }
}
