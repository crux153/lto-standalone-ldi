/**
 * Drive_Status (Drive-to-Library, Type=0xAB, Subtype=0x40) - spec pages 26-29.
 *
 * ```
 * byte  0       Msg Type (0xAB)
 * byte  1       Tgt Addr (0xFF)
 * bytes 2-5     Msg ID
 * byte  6       Msg Subtype (0x40)
 * byte  7       Drive Status Flags 1
 * byte  8       Additional Status Length (0x17)
 * byte  9       Display Character
 * byte  10      Display Character Rate
 * byte  11      Status LED
 * byte  12      Status LED Rate
 * byte  13      Tape Motion
 * bytes 14-21   Tape VolSer
 * bytes 22-29   TapeAlert Flags
 * byte  30      Drive Status Flags 2
 * byte  31      Drive Status Flags 3
 * ```
 *
 * In non-polled mode the drive sends this unprompted after it accepts a
 * Set_Config that needs no reset, and whenever a cartridge is loaded or
 * unloaded. Receiving one right after a Set_Config is the drive confirming the
 * handshake completed.
 */

import { MessageSubtype, MessageType } from '../constants.js';
import { MessageParseError, parseHeader, readSubtype, type MessageHeader } from './header.js';

/** Length of a complete Drive_Status message. */
export const DRIVE_STATUS_LENGTH = 32;

/** Value the drive reports in byte 8. */
export const ADDITIONAL_STATUS_LENGTH = 0x17;

/** Byte 7: Drive Status Flags 1. */
export interface DriveStatusFlags1 {
  /** Bit 7. 1 means no cartridge is loaded. */
  cartridgeNotLoaded: boolean;
  /** Bit 6. 1 means the drive needs cleaning. */
  driveCleanRequired: boolean;
  /** Bit 4. 1 means a write-protected cartridge is loaded. */
  writeProtectedCartridge: boolean;
  /** Bit 3. 1 means compression is enabled. */
  compressionEnabled: boolean;
  /** Bit 2. 1 means a cartridge is present, possibly in the ejected position. */
  cartridgePresent: boolean;
  /** Bit 0. 1 means LUN 0 is in a SCSI Ready condition. */
  lun0Ready: boolean;
  value: number;
}

/** Byte 30: Drive Status Flags 2. */
export interface DriveStatusFlags2 {
  /** Bit 7. 0 = SCSI, 1 = Fibre Channel. */
  fibreChannel: boolean;
  /** Bit 4. 1 means the drive is offline. */
  offline: boolean;
  /** Bit 3. Fibre Channel only: 1 means hard AL_PA addressing. */
  hardAlpa: boolean;
  /** Bit 2. Fibre Channel only: 1 means the AL_PA is taken or unavailable. */
  alpaConflict: boolean;
  /** Bit 1. Fibre Channel only: 1 means light was detected on the link. */
  lightDetected: boolean;
  /** Bit 0. Fibre Channel only: 1 means loop initialisation is complete. */
  loopInitialized: boolean;
  value: number;
}

/** Byte 31: Drive Status Flags 3. */
export interface DriveStatusFlags3 {
  /** Bit 7. 1 means power-on self test is still running. */
  postProcessing: boolean;
  /** Bits 3..0, the cartridge type code. */
  cartridgeType: number;
  /** Human-readable form of {@link cartridgeType}. */
  cartridgeTypeDescription: string;
  value: number;
}

/** Cartridge position derived from Drive Status Flags 1 bits 7, 2 and 0. */
export type CartridgePosition =
  | 'not-present'
  | 'ejected-loadable'
  | 'cm-accessible-not-threaded'
  | 'loaded-and-threaded'
  | 'undefined';

/** A decoded Drive_Status message. */
export interface DriveStatus extends MessageHeader {
  kind: 'drive-status';
  msgSubtype: number;
  flags1: DriveStatusFlags1;
  additionalStatusLength: number;
  /** Byte 9: mirrors the single-character display on the drive front panel. */
  displayCharacter: string;
  displayCharacterByte: number;
  /** Byte 10: flashing rate of the single-character display. */
  displayCharacterRate: number;
  displayCharacterRateDescription: string;
  /** Byte 11: the dual-colour status LED. */
  statusLed: number;
  statusLedDescription: string;
  /** Byte 12: flashing rate of the status LED. */
  statusLedRate: number;
  statusLedRateDescription: string;
  /** Byte 13: what the tape is currently doing. */
  tapeMotion: number;
  tapeMotionDescription: string;
  /** Bytes 14..21: the volume serial number of the loaded cartridge. */
  tapeVolSer: string;
  tapeVolSerRaw: Buffer;
  /** Bytes 22..29: TapeAlert flags as a bitmap, byte 22 bit 7 being flag 1. */
  tapeAlertFlagsRaw: Buffer;
  /** The 1-based numbers of every TapeAlert flag currently set. */
  tapeAlertFlags: number[];
  flags2: DriveStatusFlags2;
  flags3: DriveStatusFlags3;
  cartridgePosition: CartridgePosition;
  raw: Buffer;
}

/** Tape Motion values (byte 13). The spec lists these in decimal. */
const TAPE_MOTION: Record<number, string> = {
  0: 'No current motion',
  1: 'Writing',
  2: 'Reading',
  3: 'Erasing',
  10: 'Locating',
  11: 'Rewinding',
  20: 'Cleaning',
  30: 'Unloading',
  32: 'Loading',
};

/** Status LED colours (byte 11). */
const STATUS_LED: Record<number, string> = {
  0: 'Off',
  1: 'Green',
  2: 'Yellow',
};

/** Blink rates shared by the display character and the status LED. */
const BLINK_RATE: Record<number, string> = {
  0x00: 'Off, blank',
  0x01: 'Blinking at 1 Hz',
  0x02: 'Blinking at 2 Hz',
  0x04: 'Blinking at 4 Hz',
  0x7f: 'On solid, no blinking',
};

/** Tape cartridge types (byte 31, bits 3..0). */
const CARTRIDGE_TYPE: Record<number, string> = {
  0b0000: 'No tape present or cartridge not mounted successfully',
  0b0001: 'Standard LTO Generation 1 format',
  0b0010: 'Cleaner cartridge',
  0b0011: 'Drive FMR tape created via the Maintenance Panel',
  0b0100: 'Drive FMR tape created via Maint Command Create Drive FMR Cartridge',
  0b0110: 'Invalid cleaner cartridge',
  0b0111: 'Invalid cartridge type',
};

/** True when `message` is a Two_Way message carrying subtype Drive_Status. */
export function isDriveStatus(message: Uint8Array): boolean {
  return (
    message.length >= 7 &&
    message[0] === MessageType.TWO_WAY &&
    message[6] === MessageSubtype.DRIVE_STATUS
  );
}

/**
 * Parses a Drive_Status message.
 *
 * @throws {MessageParseError} If the message is not a Two_Way/0x40 message, or
 * is shorter than the 32 bytes the spec defines.
 */
export function parseDriveStatus(message: Uint8Array): DriveStatus {
  const header = parseHeader(message);

  if (header.msgType !== MessageType.TWO_WAY) {
    throw new MessageParseError(
      `expected Msg Type 0xAB (Two_Way), received 0x${header.msgType.toString(16).padStart(2, '0').toUpperCase()}`,
    );
  }
  const subtype = readSubtype(message);
  if (subtype !== MessageSubtype.DRIVE_STATUS) {
    throw new MessageParseError(
      `expected Msg Subtype 0x40 (Drive_Status), received ` +
        (subtype === undefined
          ? 'no subtype byte'
          : `0x${subtype.toString(16).padStart(2, '0').toUpperCase()}`),
    );
  }
  if (message.length < DRIVE_STATUS_LENGTH) {
    throw new MessageParseError(
      `Drive_Status is ${message.length} bytes, shorter than the ${DRIVE_STATUS_LENGTH}-byte minimum`,
    );
  }

  const raw = Buffer.from(message);
  const flags1 = decodeFlags1(raw[7]!);
  const flags2 = decodeFlags2(raw[30]!);
  const flags3 = decodeFlags3(raw[31]!);

  const displayCharacterByte = raw[9]!;
  const tapeVolSerRaw = Buffer.from(raw.subarray(14, 22));
  const tapeAlertFlagsRaw = Buffer.from(raw.subarray(22, 30));

  return {
    kind: 'drive-status',
    ...header,
    msgSubtype: subtype,
    flags1,
    additionalStatusLength: raw[8]!,
    displayCharacter: isPrintable(displayCharacterByte)
      ? String.fromCharCode(displayCharacterByte)
      : '',
    displayCharacterByte,
    displayCharacterRate: raw[10]!,
    displayCharacterRateDescription: BLINK_RATE[raw[10]!] ?? 'Reserved',
    statusLed: raw[11]!,
    statusLedDescription: STATUS_LED[raw[11]!] ?? 'Reserved',
    statusLedRate: raw[12]!,
    statusLedRateDescription: BLINK_RATE[raw[12]!] ?? 'Reserved',
    tapeMotion: raw[13]!,
    tapeMotionDescription: TAPE_MOTION[raw[13]!] ?? 'Reserved',
    tapeVolSer: tapeVolSerRaw.toString('latin1').replace(/\0+$/, '').trimEnd(),
    tapeVolSerRaw,
    tapeAlertFlagsRaw,
    tapeAlertFlags: decodeTapeAlertFlags(tapeAlertFlagsRaw),
    flags2,
    flags3,
    cartridgePosition: deriveCartridgePosition(flags1),
    raw,
  };
}

function decodeFlags1(value: number): DriveStatusFlags1 {
  const bit = (position: number): boolean => (value & (1 << position)) !== 0;
  return {
    cartridgeNotLoaded: bit(7),
    driveCleanRequired: bit(6),
    writeProtectedCartridge: bit(4),
    compressionEnabled: bit(3),
    cartridgePresent: bit(2),
    lun0Ready: bit(0),
    value,
  };
}

function decodeFlags2(value: number): DriveStatusFlags2 {
  const bit = (position: number): boolean => (value & (1 << position)) !== 0;
  return {
    fibreChannel: bit(7),
    offline: bit(4),
    hardAlpa: bit(3),
    alpaConflict: bit(2),
    lightDetected: bit(1),
    loopInitialized: bit(0),
    value,
  };
}

function decodeFlags3(value: number): DriveStatusFlags3 {
  const cartridgeType = value & 0b1111;
  return {
    postProcessing: (value & (1 << 7)) !== 0,
    cartridgeType,
    cartridgeTypeDescription: CARTRIDGE_TYPE[cartridgeType] ?? 'Reserved',
    value,
  };
}

/**
 * Derives the cartridge position from bits 7, 2 and 0 of Drive Status Flags 1,
 * using the table in the spec's Drive_Status legend.
 */
export function deriveCartridgePosition(flags1: DriveStatusFlags1): CartridgePosition {
  const key = `${flags1.cartridgeNotLoaded ? 1 : 0}${flags1.cartridgePresent ? 1 : 0}${flags1.lun0Ready ? 1 : 0}`;
  switch (key) {
    case '100':
      return 'not-present';
    case '110':
      return 'ejected-loadable';
    case '010':
      return 'cm-accessible-not-threaded';
    case '011':
      return 'loaded-and-threaded';
    default:
      return 'undefined';
  }
}

/**
 * Expands the eight TapeAlert bytes into the 1-based flag numbers that are set.
 *
 * Byte 22 bit 7 is TapeAlert flag 1 and byte 29 bit 0 is flag 64.
 */
export function decodeTapeAlertFlags(bytes: Uint8Array): number[] {
  const flags: number[] = [];
  for (let index = 0; index < bytes.length * 8; index++) {
    const byte = bytes[index >> 3]!;
    if ((byte & (1 << (7 - (index & 7)))) !== 0) {
      flags.push(index + 1);
    }
  }
  return flags;
}

const CARTRIDGE_POSITION_TEXT: Record<CartridgePosition, string> = {
  'not-present': 'Cartridge not present',
  'ejected-loadable': 'Cartridge present in ejected/loadable position',
  'cm-accessible-not-threaded': 'Cartridge present in LTO-CM accessible position, not threaded',
  'loaded-and-threaded': 'Cartridge present, loaded and threaded',
  undefined: 'Undefined bit combination',
};

/** Renders a Drive_Status as a multi-line report. */
export function formatDriveStatus(status: DriveStatus): string {
  const yesNo = (value: boolean): string => (value ? 'yes' : 'no');

  const lines = [
    'Drive_Status (Drive-to-Library, Type=0xAB, Subtype=0x40)',
    `  Tgt Addr           : 0x${hex(status.tgtAddr)}`,
    `  Msg ID             : ${formatHexBytes(status.msgId)}`,
    `  Drive Status Flags1: 0x${hex(status.flags1.value)}`,
    `    cartridge not loaded         : ${yesNo(status.flags1.cartridgeNotLoaded)}`,
    `    drive clean required         : ${yesNo(status.flags1.driveCleanRequired)}`,
    `    write-protected cartridge    : ${yesNo(status.flags1.writeProtectedCartridge)}`,
    `    compression enabled          : ${yesNo(status.flags1.compressionEnabled)}`,
    `    cartridge present            : ${yesNo(status.flags1.cartridgePresent)}`,
    `    LUN 0 ready                  : ${yesNo(status.flags1.lun0Ready)}`,
    `    cartridge position           : ${CARTRIDGE_POSITION_TEXT[status.cartridgePosition]}`,
    `  Display character  : ${status.displayCharacter ? JSON.stringify(status.displayCharacter) : `0x${hex(status.displayCharacterByte)}`} (${status.displayCharacterRateDescription})`,
    `  Status LED         : ${status.statusLedDescription} (${status.statusLedRateDescription})`,
    `  Tape motion        : ${status.tapeMotionDescription}`,
    `  Tape VolSer        : ${status.tapeVolSer ? JSON.stringify(status.tapeVolSer) : '(none)'}`,
    `  TapeAlert flags    : ${status.tapeAlertFlags.length > 0 ? status.tapeAlertFlags.join(', ') : 'none set'}`,
    `  Drive Status Flags2: 0x${hex(status.flags2.value)}`,
    `    communication type           : ${status.flags2.fibreChannel ? 'Fibre Channel' : 'SCSI'}`,
    `    online                       : ${status.flags2.offline ? 'no (offline)' : 'yes'}`,
  ];

  if (status.flags2.fibreChannel) {
    lines.push(
      `    hard AL_PA addressing        : ${yesNo(status.flags2.hardAlpa)}`,
      `    AL_PA conflict               : ${yesNo(status.flags2.alpaConflict)}`,
      `    light detected               : ${yesNo(status.flags2.lightDetected)}`,
      `    loop initialised             : ${yesNo(status.flags2.loopInitialized)}`,
    );
  }

  lines.push(
    `  Drive Status Flags3: 0x${hex(status.flags3.value)}`,
    `    POST processing              : ${status.flags3.postProcessing ? 'in progress' : 'complete'}`,
    `    cartridge type               : ${status.flags3.cartridgeTypeDescription}`,
  );

  return lines.join('\n');
}

function isPrintable(byte: number): boolean {
  return byte >= 0x20 && byte <= 0x7e;
}

function hex(byte: number): string {
  return byte.toString(16).padStart(2, '0').toUpperCase();
}

function formatHexBytes(bytes: Uint8Array): string {
  return [...bytes].map(hex).join(' ');
}
