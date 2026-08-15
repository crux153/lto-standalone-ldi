/**
 * The Drive Type Request / Drive Type primitives (spec, "Primitives").
 *
 * These are the only two exchanges that happen outside the packet protocol:
 * there is no start-text, length, checksum, end-text, acknowledgement or byte
 * stuffing involved. A library sends a single 0x00 byte and the drive answers
 * with nine bytes:
 *
 * ```
 * byte 0     0xFA
 * byte 1     0x49 ASCII 'I'
 * byte 2     0x42 ASCII 'B'
 * byte 3     0x4D ASCII 'M'
 * byte 4     0x80
 * bytes 5-8  Firmware Revision, MSB first
 * ```
 *
 * Because it needs no handshake, this exchange doubles as the quickest way to
 * prove that the RS-422 wiring is correct in both directions.
 */

import {
  DRIVE_TYPE_DEVICE_BYTE,
  DRIVE_TYPE_HEADER_BYTE,
  DRIVE_TYPE_REQUEST_BYTE,
  DRIVE_TYPE_RESPONSE_LENGTH,
  DRIVE_TYPE_VENDOR_ID,
} from '../constants.js';
import { MessageParseError } from './header.js';

/** The Drive Type Request primitive: a single 0x00 byte. */
export const DRIVE_TYPE_REQUEST = Buffer.from([DRIVE_TYPE_REQUEST_BYTE]);

/** A decoded Drive Type response. */
export interface DriveType {
  /** Byte 0. Expected to be 0xFA. */
  header: number;
  /** Bytes 1..3 decoded as ASCII. An IBM drive answers "IBM". */
  vendor: string;
  /** Byte 4. Expected to be 0x80 for an IBM LTO tape drive. */
  deviceByte: number;
  /** Bytes 5..8, the firmware revision, most significant byte first. */
  firmwareRevision: Buffer;
  /**
   * The firmware revision rendered as the four ASCII characters the drive
   * reports, when all four bytes are printable; otherwise undefined.
   */
  firmwareRevisionAscii?: string;
  /** The firmware revision as an unsigned 32-bit big-endian integer. */
  firmwareRevisionValue: number;
  /** True when byte 0, the vendor field and byte 4 all match the spec. */
  isIbmDrive: boolean;
  /** The nine bytes as received. */
  raw: Buffer;
}

/**
 * Parses a nine-byte Drive Type response.
 *
 * Parsing never fails on unexpected field values; it reports them through
 * {@link DriveType.isIbmDrive} so a caller can show what actually arrived. Only
 * a wrong length is an error.
 *
 * @throws {MessageParseError} If `data` is not exactly nine bytes long.
 */
export function parseDriveType(data: Uint8Array): DriveType {
  if (data.length !== DRIVE_TYPE_RESPONSE_LENGTH) {
    throw new MessageParseError(
      `Drive Type response must be exactly ${DRIVE_TYPE_RESPONSE_LENGTH} bytes, received ${data.length}`,
    );
  }

  const raw = Buffer.from(data);
  const header = raw[0]!;
  const vendor = raw.subarray(1, 4).toString('latin1');
  const deviceByte = raw[4]!;
  const firmwareRevision = Buffer.from(raw.subarray(5, 9));

  const isPrintable = [...firmwareRevision].every((byte) => byte >= 0x20 && byte <= 0x7e);

  const result: DriveType = {
    header,
    vendor,
    deviceByte,
    firmwareRevision,
    firmwareRevisionValue: firmwareRevision.readUInt32BE(0),
    isIbmDrive:
      header === DRIVE_TYPE_HEADER_BYTE &&
      vendor === DRIVE_TYPE_VENDOR_ID &&
      deviceByte === DRIVE_TYPE_DEVICE_BYTE,
    raw,
  };

  if (isPrintable) {
    result.firmwareRevisionAscii = firmwareRevision.toString('latin1');
  }

  return result;
}

/**
 * Explains why a Drive Type response was not accepted as an IBM drive.
 *
 * @returns One human-readable reason per mismatching field; empty when the
 * response is a valid IBM drive identification.
 */
export function describeDriveTypeMismatches(driveType: DriveType): string[] {
  const problems: string[] = [];

  if (driveType.header !== DRIVE_TYPE_HEADER_BYTE) {
    problems.push(
      `byte 0 is 0x${hex(driveType.header)}, expected 0x${hex(DRIVE_TYPE_HEADER_BYTE)}`,
    );
  }
  if (driveType.vendor !== DRIVE_TYPE_VENDOR_ID) {
    problems.push(
      `bytes 1-3 are ${JSON.stringify(driveType.vendor)}, expected ${JSON.stringify(DRIVE_TYPE_VENDOR_ID)}`,
    );
  }
  if (driveType.deviceByte !== DRIVE_TYPE_DEVICE_BYTE) {
    problems.push(
      `byte 4 is 0x${hex(driveType.deviceByte)}, expected 0x${hex(DRIVE_TYPE_DEVICE_BYTE)}`,
    );
  }

  return problems;
}

/** Renders a Drive Type response as a multi-line report. */
export function formatDriveType(driveType: DriveType): string {
  const lines = [
    'Drive Type (primitive response, 9 bytes)',
    `  Raw                : ${formatHexBytes(driveType.raw)}`,
    `  Header byte        : 0x${hex(driveType.header)}`,
    `  Vendor             : ${JSON.stringify(driveType.vendor)}`,
    `  Device byte        : 0x${hex(driveType.deviceByte)}`,
    `  Firmware revision  : ${formatHexBytes(driveType.firmwareRevision)}` +
      (driveType.firmwareRevisionAscii ? ` (${JSON.stringify(driveType.firmwareRevisionAscii)})` : ''),
  ];

  if (driveType.isIbmDrive) {
    lines.push('  Verdict            : OK - drive identifies itself as IBM');
  } else {
    lines.push('  Verdict            : MISMATCH');
    for (const problem of describeDriveTypeMismatches(driveType)) {
      lines.push(`                       - ${problem}`);
    }
  }

  return lines.join('\n');
}

function hex(byte: number): string {
  return byte.toString(16).padStart(2, '0').toUpperCase();
}

function formatHexBytes(bytes: Uint8Array): string {
  return [...bytes].map(hex).join(' ');
}
