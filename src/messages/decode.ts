/**
 * Dispatches a received message body to the matching parser.
 */

import { MessageSubtype, MessageType } from '../constants.js';
import { formatConfigRequest, parseConfigRequest, type ConfigRequest } from './config-request.js';
import { formatDriveStatus, parseDriveStatus, type DriveStatus } from './drive-status.js';
import { parseHeader, readSubtype, type MessageHeader } from './header.js';
import { parseMaintStatus, type MaintStatus } from './maint.js';
import { formatSetConfig, parseSetConfig, type ParsedSetConfig } from './set-config.js';

/** A message whose type or subtype this library does not decode in detail. */
export interface UnknownMessage extends MessageHeader {
  kind: 'unknown';
  msgSubtype?: number;
  raw: Buffer;
}

/** Any message this library can produce from a packet body. */
export type LdiMessage =
  | ConfigRequest
  | ParsedSetConfig
  | DriveStatus
  | MaintStatus
  | UnknownMessage;

/**
 * Decodes a message body into a typed message.
 *
 * Unrecognised types and subtypes come back as {@link UnknownMessage} rather
 * than raising: the spec tells a library that receives an unlisted message type
 * to ACK it and take no further action.
 */
export function decodeMessage(message: Uint8Array): LdiMessage {
  const header = parseHeader(message);

  if (header.msgType === MessageType.SET_CONFIG) {
    return parseSetConfig(message);
  }

  if (header.msgType === MessageType.TWO_WAY) {
    switch (readSubtype(message)) {
      case MessageSubtype.CONFIG_REQUEST:
        return parseConfigRequest(message);
      case MessageSubtype.DRIVE_STATUS:
        return parseDriveStatus(message);
      case MessageSubtype.MAINT_STATUS_GOOD:
      case MessageSubtype.MAINT_STATUS_ERROR:
        return parseMaintStatus(message);
      default:
        break;
    }
  }

  const unknown: UnknownMessage = {
    kind: 'unknown',
    ...header,
    raw: Buffer.from(message),
  };
  const subtype = readSubtype(message);
  if (header.msgType === MessageType.TWO_WAY && subtype !== undefined) {
    unknown.msgSubtype = subtype;
  }
  return unknown;
}

/** Renders any decoded message as a multi-line report. */
export function formatMessage(message: LdiMessage): string {
  switch (message.kind) {
    case 'config-request':
      return formatConfigRequest(message);
    case 'set-config':
      return formatSetConfig(message);
    case 'drive-status':
      return formatDriveStatus(message);
    case 'maint-status-good':
    case 'maint-status-error':
      return [
        `${message.kind === 'maint-status-good' ? 'Maint_Status_Good' : 'Maint_Status_Error'} ` +
          `(Drive-to-Library, Type=0xAB, Subtype=0x${message.msgSubtype.toString(16).toUpperCase()})`,
        `  Msg ID             : ${formatHexBytes(message.msgId)}`,
        `  Section            : ${message.sectionNumber}${message.moreSections ? ' (more to follow)' : ' (last)'}`,
        `  Section size       : ${message.sectionSize} bytes`,
        `  Data               : ${message.data.length > 0 ? formatHexBytes(message.data.subarray(0, 32)) + (message.data.length > 32 ? ' ...' : '') : '(none)'}`,
      ].join('\n');
    case 'unknown':
      return [
        'Unknown message',
        `  Msg Type           : 0x${hex(message.msgType)}`,
        `  Tgt Addr           : 0x${hex(message.tgtAddr)}`,
        `  Msg ID             : ${formatHexBytes(message.msgId)}`,
        ...(message.msgSubtype !== undefined
          ? [`  Msg Subtype        : 0x${hex(message.msgSubtype)}`]
          : []),
        `  Raw                : ${formatHexBytes(message.raw)}`,
      ].join('\n');
  }
}

function hex(byte: number): string {
  return byte.toString(16).padStart(2, '0').toUpperCase();
}

function formatHexBytes(bytes: Uint8Array): string {
  return [...bytes].map(hex).join(' ');
}
