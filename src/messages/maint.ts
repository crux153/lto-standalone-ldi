/**
 * Maint_Command (Library-to-Drive, Type=0xAB, Subtype=0x30) and its responses
 * Maint_Status_Good (0x3C) and Maint_Status_Error (0x3F) - spec pages 18-26.
 *
 * ```
 * byte  0     Msg Type (0xAB)
 * byte  1     Tgt Addr
 * bytes 2-5   Msg ID
 * byte  6     Msg Subtype (0x30)
 * byte  7     Maintenance Sub-command
 * bytes 8..n  Parameter data, per sub-command
 * ```
 *
 * A drive NAKs Two_Way messages until the Config_Request/Set_Config handshake
 * has completed, so send a Set_Config before any Maint_Command.
 */

import { MessageSubtype, MessageType } from '../constants.js';
import { encodeHeader, MessageParseError, parseHeader, readSubtype, type MessageHeader } from './header.js';

/** Builds a Maint_Command message. */
export function buildMaintCommand(options: {
  tgtAddr: number;
  msgId: Uint8Array;
  subCommand: number;
  parameters?: Uint8Array;
}): Buffer {
  return Buffer.concat([
    encodeHeader({
      msgType: MessageType.TWO_WAY,
      tgtAddr: options.tgtAddr,
      msgId: Buffer.from(options.msgId),
    }),
    Buffer.from([MessageSubtype.MAINT_COMMAND, options.subCommand]),
    Buffer.from(options.parameters ?? []),
  ]);
}

/** Builds a Drive_Status_Request message (spec page 29). */
export function buildDriveStatusRequest(options: {
  tgtAddr: number;
  msgId: Uint8Array;
}): Buffer {
  return Buffer.concat([
    encodeHeader({
      msgType: MessageType.TWO_WAY,
      tgtAddr: options.tgtAddr,
      msgId: Buffer.from(options.msgId),
    }),
    Buffer.from([MessageSubtype.DRIVE_STATUS_REQUEST]),
  ]);
}

/** Common shape of the two Maint_Status responses. */
export interface MaintStatus extends MessageHeader {
  kind: 'maint-status-good' | 'maint-status-error';
  msgSubtype: number;
  /** Byte 7. Starts at 0x00 and increments for multi-section data. */
  sectionNumber: number;
  /** Byte 8. 0x00 is the last section, 0x80 means more sections follow. */
  sectionFlag: number;
  /** True when more sections are still to come. */
  moreSections: boolean;
  /** Bytes 9..10: the size of the data in this section. */
  sectionSize: number;
  /** Bytes 11..n: the section payload. */
  data: Buffer;
  raw: Buffer;
}

/**
 * Parses a Maint_Status_Good or Maint_Status_Error message.
 *
 * Both share a layout: only the subtype and the meaning of the payload differ.
 * For Maint_Status_Error the payload is SCSI Request Sense data.
 */
export function parseMaintStatus(message: Uint8Array): MaintStatus {
  const header = parseHeader(message);
  const subtype = readSubtype(message);

  if (
    header.msgType !== MessageType.TWO_WAY ||
    (subtype !== MessageSubtype.MAINT_STATUS_GOOD && subtype !== MessageSubtype.MAINT_STATUS_ERROR)
  ) {
    throw new MessageParseError('message is not a Maint_Status_Good or Maint_Status_Error');
  }
  if (message.length < 11) {
    throw new MessageParseError(
      `Maint_Status is ${message.length} bytes, shorter than the 11-byte header`,
    );
  }

  const raw = Buffer.from(message);
  const sectionFlag = raw[8]!;
  const sectionSize = raw.readUInt16BE(9);

  return {
    kind: subtype === MessageSubtype.MAINT_STATUS_GOOD ? 'maint-status-good' : 'maint-status-error',
    ...header,
    msgSubtype: subtype,
    sectionNumber: raw[7]!,
    sectionFlag,
    moreSections: sectionFlag === 0x80,
    sectionSize,
    data: Buffer.from(raw.subarray(11, 11 + sectionSize)),
    raw,
  };
}
