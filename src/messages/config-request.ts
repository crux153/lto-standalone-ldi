/**
 * Config_Request (Drive-to-Library, Type=0xAB, Subtype=0x01) - spec page 16.
 *
 * ```
 * byte 0     Msg Type (0xAB)
 * byte 1     Tgt Addr (0xFF)
 * bytes 2-5  Msg ID
 * byte 6     Msg Subtype (0x01)
 * ```
 *
 * A drive whose feature switches select non-polled mode starts the handshake
 * itself by sending this message within ten seconds of power-up or reset, and
 * NAKs every Two_Way message until the handshake completes. The library answers
 * with a Set_Config carrying the same four Msg ID bytes.
 */

import { MessageSubtype, MessageType } from '../constants.js';
import { MessageParseError, parseHeader, readSubtype, type MessageHeader } from './header.js';

/** Number of bytes in a Config_Request message. */
export const CONFIG_REQUEST_LENGTH = 7;

/** A decoded Config_Request. */
export interface ConfigRequest extends MessageHeader {
  kind: 'config-request';
  /** Byte 6, always 0x01. */
  msgSubtype: number;
  /** The message bytes as received. */
  raw: Buffer;
}

/** True when `message` is a Two_Way message carrying subtype Config_Request. */
export function isConfigRequest(message: Uint8Array): boolean {
  return (
    message.length >= CONFIG_REQUEST_LENGTH &&
    message[0] === MessageType.TWO_WAY &&
    message[6] === MessageSubtype.CONFIG_REQUEST
  );
}

/**
 * Parses a Config_Request message.
 *
 * @throws {MessageParseError} If the message is too short, or is not a Two_Way
 * message of subtype 0x01.
 */
export function parseConfigRequest(message: Uint8Array): ConfigRequest {
  const header = parseHeader(message);

  if (header.msgType !== MessageType.TWO_WAY) {
    throw new MessageParseError(
      `expected Msg Type 0x${MessageType.TWO_WAY.toString(16).toUpperCase()} (Two_Way), ` +
        `received 0x${header.msgType.toString(16).padStart(2, '0').toUpperCase()}`,
    );
  }

  const subtype = readSubtype(message);
  if (subtype === undefined) {
    throw new MessageParseError('Two_Way message has no subtype byte');
  }
  if (subtype !== MessageSubtype.CONFIG_REQUEST) {
    throw new MessageParseError(
      `expected Msg Subtype 0x01 (Config_Request), ` +
        `received 0x${subtype.toString(16).padStart(2, '0').toUpperCase()}`,
    );
  }

  return {
    kind: 'config-request',
    ...header,
    msgSubtype: subtype,
    raw: Buffer.from(message),
  };
}

/**
 * Builds a Config_Request message.
 *
 * A library never sends this message; it is provided so a test or a simulated
 * drive can produce one.
 */
export function buildConfigRequest(msgId: Uint8Array): Buffer {
  if (msgId.length !== 4) {
    throw new RangeError(`Msg ID must be exactly 4 bytes, received ${msgId.length}`);
  }
  return Buffer.concat([
    Buffer.from([MessageType.TWO_WAY, 0xff]),
    Buffer.from(msgId),
    Buffer.from([MessageSubtype.CONFIG_REQUEST]),
  ]);
}

/** Renders a Config_Request as a multi-line report. */
export function formatConfigRequest(request: ConfigRequest): string {
  const originator = request.msgId[0]!;

  return [
    'Config_Request (Drive-to-Library, Type=0xAB, Subtype=0x01)',
    `  Raw                : ${formatHexBytes(request.raw)}`,
    `  Msg Type           : 0x${hex(request.msgType)} (Two_Way)`,
    `  Tgt Addr           : 0x${hex(request.tgtAddr)} ${describeTargetAddress(request.tgtAddr)}`,
    `  Msg ID             : ${formatHexBytes(request.msgId)}`,
    `    originator LDI   : 0x${hex(originator)} ${describeTargetAddress(originator)}`,
    `    key              : ${formatHexBytes(request.msgId.subarray(1))}`,
    `  Msg Subtype        : 0x${hex(request.msgSubtype)} (Config_Request)`,
    '  Meaning            : the drive is asking the library for its configuration.',
    '                       Reply with a Set_Config carrying these same Msg ID bytes.',
  ].join('\n');
}

/** Describes what an LDI address value stands for. */
export function describeTargetAddress(address: number): string {
  if (address === 0xff) return '(library)';
  if (address === 0x00) return '(unassigned)';
  if (address >= 0x01 && address <= 0xfe) return `(drive ${address})`;
  return '(reserved)';
}

function hex(byte: number): string {
  return byte.toString(16).padStart(2, '0').toUpperCase();
}

function formatHexBytes(bytes: Uint8Array): string {
  return [...bytes].map(hex).join(' ');
}
