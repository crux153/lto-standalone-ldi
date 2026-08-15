/**
 * Set_Config (Library-to-Drive, Type=0xAC) - spec pages 16-18.
 *
 * ```
 * byte  0       Msg Type (0xAC)
 * byte  1       Tgt Addr
 * bytes 2-5     Msg ID
 * byte  6       Interface Version Major (0x02)
 * byte  7       Interface Version Minor (0x00)
 * bytes 8-25    Reserved (18 bytes)
 * byte  26      Drive FC/SCSI Address
 * bytes 27-52   Reserved (26 bytes)
 * byte  53      Configuration Flags
 * byte  54      Library Information Field
 * bytes 55-62   Drive Fibre Channel World Wide Node Name
 * byte  63      Reserved
 * ```
 *
 * This is the message that turns a library drive into a standalone drive. The
 * spec's Interface Scenarios note that "all drive firmware levels accept bytes
 * 0-53 of the Set_Config. One way to avoid problems is to always start with a
 * Set_Config of just these first 54 bytes", which is why {@link buildSetConfig}
 * emits the 54-byte form by default.
 */

import { LIBRARY_LDI_ADDRESS, MessageType } from '../constants.js';
import { assertByte, MessageParseError, MSG_ID_LENGTH, parseHeader, type MessageHeader } from './header.js';

/**
 * Length of the firmware-independent Set_Config, bytes 0..53 inclusive. Every
 * drive firmware level accepts a message of this length.
 */
export const SET_CONFIG_TRUNCATED_LENGTH = 54;

/** Length of the complete Set_Config, bytes 0..63 inclusive. */
export const SET_CONFIG_FULL_LENGTH = 64;

/** Byte offsets of the Set_Config fields. */
export const SetConfigOffset = {
  INTERFACE_VERSION_MAJOR: 6,
  INTERFACE_VERSION_MINOR: 7,
  DRIVE_ADDRESS: 26,
  CONFIGURATION_FLAGS: 53,
  LIBRARY_INFORMATION_FIELD: 54,
  WORLD_WIDE_NODE_NAME: 55,
} as const;

/** Interface version reported by this implementation (spec bytes 6 and 7). */
export const INTERFACE_VERSION_MAJOR = 0x02;
export const INTERFACE_VERSION_MINOR = 0x00;

/** Length of the Drive Fibre Channel World Wide Node Name field. */
export const WORLD_WIDE_NODE_NAME_LENGTH = 8;

/** Bit positions within the Configuration Flags byte (byte 53). */
export const ConfigurationFlagBit = {
  NON_POLLED_MODE: 7,
  DISABLE_SOFTLOAD: 6,
  DISABLE_SCSI_EJECT: 5,
  DISABLE_AUTO_EJECT_FMR_OR_CLEANER: 4,
  DISABLE_AUTOMATIC_DRIVE_ONLINE: 3,
} as const;

/** The Configuration Flags byte decoded into named fields. */
export interface ConfigurationFlags {
  /** Bit 7. 1 configures the LDI for non-polled mode, 0 for polled mode. */
  nonPolledMode: boolean;
  /** Bit 6. 1 disables the drive softload capability, overriding SCSI mode pages. */
  disableSoftload: boolean;
  /** Bit 5. 1 disables eject on a SCSI Unload command, overriding the CDB options. */
  disableScsiEject: boolean;
  /** Bit 4. 1 disables the automatic eject of an FMR or cleaner tape after a command. */
  disableAutoEjectFmrOrCleaner: boolean;
  /**
   * Bit 3. The bit this tool exists to clear.
   *
   * - 0: the drive goes online to SCSI or Fibre Channel automatically, without
   *   needing a Set_Config after each power-on. This is standalone operation.
   * - 1: the drive stays offline until a library sends it a Set_Config with a
   *   valid address.
   */
  disableAutomaticDriveOnline: boolean;
}

/** A decoded Configuration Flags byte, including the reserved low bits. */
export interface DecodedConfigurationFlags extends ConfigurationFlags {
  /** Bits 2..0, reserved by the spec. */
  reserved: number;
  /** The byte as received. */
  value: number;
}

/**
 * Default configuration flags: every bit clear.
 *
 * A zero byte means polled mode, softload enabled, SCSI eject enabled,
 * automatic FMR/cleaner eject enabled, and - the point of the exercise -
 * automatic drive online enabled.
 */
export const DEFAULT_CONFIGURATION_FLAGS: ConfigurationFlags = {
  nonPolledMode: false,
  disableSoftload: false,
  disableScsiEject: false,
  disableAutoEjectFmrOrCleaner: false,
  disableAutomaticDriveOnline: false,
};

/** Packs named flags into the Configuration Flags byte. */
export function encodeConfigurationFlags(flags: Partial<ConfigurationFlags> = {}): number {
  const merged = { ...DEFAULT_CONFIGURATION_FLAGS, ...flags };
  let value = 0;
  if (merged.nonPolledMode) value |= 1 << ConfigurationFlagBit.NON_POLLED_MODE;
  if (merged.disableSoftload) value |= 1 << ConfigurationFlagBit.DISABLE_SOFTLOAD;
  if (merged.disableScsiEject) value |= 1 << ConfigurationFlagBit.DISABLE_SCSI_EJECT;
  if (merged.disableAutoEjectFmrOrCleaner) {
    value |= 1 << ConfigurationFlagBit.DISABLE_AUTO_EJECT_FMR_OR_CLEANER;
  }
  if (merged.disableAutomaticDriveOnline) {
    value |= 1 << ConfigurationFlagBit.DISABLE_AUTOMATIC_DRIVE_ONLINE;
  }
  return value;
}

/** Unpacks the Configuration Flags byte. */
export function decodeConfigurationFlags(value: number): DecodedConfigurationFlags {
  assertByte(value, 'Configuration Flags');
  const bit = (position: number): boolean => (value & (1 << position)) !== 0;

  return {
    nonPolledMode: bit(ConfigurationFlagBit.NON_POLLED_MODE),
    disableSoftload: bit(ConfigurationFlagBit.DISABLE_SOFTLOAD),
    disableScsiEject: bit(ConfigurationFlagBit.DISABLE_SCSI_EJECT),
    disableAutoEjectFmrOrCleaner: bit(ConfigurationFlagBit.DISABLE_AUTO_EJECT_FMR_OR_CLEANER),
    disableAutomaticDriveOnline: bit(ConfigurationFlagBit.DISABLE_AUTOMATIC_DRIVE_ONLINE),
    reserved: value & 0b111,
    value,
  };
}

/** Options accepted by {@link buildSetConfig}. */
export interface SetConfigOptions {
  /**
   * Byte 1, the LDI address to assign to the drive. Valid values are 0x01
   * through 0xFE; the drive stores this in non-volatile storage.
   *
   * @default 0x01
   */
  tgtAddr?: number;

  /**
   * Bytes 2..5. When answering a Config_Request this *must* be the four Msg ID
   * bytes from that request; {@link buildSetConfigResponse} does that for you.
   *
   * @default Buffer.from([0x00, 0x00, 0x00, 0x01])
   */
  msgId?: Uint8Array;

  /**
   * Byte 26, the I/O address handed to the drive. Valid SCSI addresses are
   * 0..15; for Fibre Channel this is a Loop ID (not an AL_PA) in the range
   * 0..127, where 126 and 127 select soft addressing.
   *
   * @default 0
   */
  driveAddress?: number;

  /** Byte 53. Individual flags, merged over {@link DEFAULT_CONFIGURATION_FLAGS}. */
  flags?: Partial<ConfigurationFlags>;

  /**
   * Byte 53 as a literal value. Overrides `flags` entirely; useful for
   * reproducing a captured packet byte for byte.
   */
  configurationFlagsByte?: number;

  /**
   * Byte 54. Relayed to the SCSI host in byte 35 of every Request Sense
   * response. Only present in the full-length message.
   *
   * @default 0
   */
  libraryInformationField?: number;

  /**
   * Bytes 55..62. A value of zero instructs the drive to use its own world wide
   * names. Only present in the full-length message.
   *
   * @default eight zero bytes
   */
  worldWideNodeName?: Uint8Array;

  /**
   * Emit the 54-byte firmware-independent form (bytes 0..53) rather than the
   * complete 64-byte message. The spec recommends always starting with the
   * short form.
   *
   * @default true
   */
  truncated?: boolean;

  /** Byte 6. Only override this to reproduce a captured packet. */
  interfaceVersionMajor?: number;

  /** Byte 7. Only override this to reproduce a captured packet. */
  interfaceVersionMinor?: number;
}

/**
 * Builds a Set_Config message.
 *
 * With no options this produces the 54-byte message that clears Configuration
 * Flags bit 3, which is exactly the message that puts a library drive into
 * standalone mode.
 */
export function buildSetConfig(options: SetConfigOptions = {}): Buffer {
  const {
    tgtAddr = 0x01,
    msgId = Buffer.from([0x00, 0x00, 0x00, 0x01]),
    driveAddress = 0,
    libraryInformationField = 0,
    truncated = true,
    interfaceVersionMajor = INTERFACE_VERSION_MAJOR,
    interfaceVersionMinor = INTERFACE_VERSION_MINOR,
  } = options;

  assertByte(tgtAddr, 'Tgt Addr');
  assertByte(driveAddress, 'Drive FC/SCSI Address');
  assertByte(libraryInformationField, 'Library Information Field');
  assertByte(interfaceVersionMajor, 'Interface Version Major');
  assertByte(interfaceVersionMinor, 'Interface Version Minor');

  if (msgId.length !== MSG_ID_LENGTH) {
    throw new RangeError(`Msg ID must be exactly ${MSG_ID_LENGTH} bytes, received ${msgId.length}`);
  }

  const configurationFlags =
    options.configurationFlagsByte ?? encodeConfigurationFlags(options.flags);
  assertByte(configurationFlags, 'Configuration Flags');

  const length = truncated ? SET_CONFIG_TRUNCATED_LENGTH : SET_CONFIG_FULL_LENGTH;
  const message = Buffer.alloc(length);

  message[0] = MessageType.SET_CONFIG;
  message[1] = tgtAddr;
  Buffer.from(msgId).copy(message, 2);
  message[SetConfigOffset.INTERFACE_VERSION_MAJOR] = interfaceVersionMajor;
  message[SetConfigOffset.INTERFACE_VERSION_MINOR] = interfaceVersionMinor;
  // Bytes 8..25 are reserved and stay zero.
  message[SetConfigOffset.DRIVE_ADDRESS] = driveAddress;
  // Bytes 27..52 are reserved and stay zero.
  message[SetConfigOffset.CONFIGURATION_FLAGS] = configurationFlags;

  if (!truncated) {
    message[SetConfigOffset.LIBRARY_INFORMATION_FIELD] = libraryInformationField;

    const wwnn = Buffer.from(options.worldWideNodeName ?? Buffer.alloc(WORLD_WIDE_NODE_NAME_LENGTH));
    if (wwnn.length !== WORLD_WIDE_NODE_NAME_LENGTH) {
      throw new RangeError(
        `World Wide Node Name must be exactly ${WORLD_WIDE_NODE_NAME_LENGTH} bytes, received ${wwnn.length}`,
      );
    }
    wwnn.copy(message, SetConfigOffset.WORLD_WIDE_NODE_NAME);
    // Byte 63 is reserved and stays zero.
  }

  return message;
}

/**
 * Builds the Set_Config that answers a Config_Request.
 *
 * The spec is emphatic that all four Msg ID bytes must be identical to those in
 * the Config_Request, even when the drive's LDI address is about to change - a
 * new address is communicated through Tgt Addr, not through the Msg ID.
 */
export function buildSetConfigResponse(
  request: Pick<MessageHeader, 'msgId'>,
  options: Omit<SetConfigOptions, 'msgId'> = {},
): Buffer {
  return buildSetConfig({ ...options, msgId: request.msgId });
}

/** A decoded Set_Config message. */
export interface ParsedSetConfig extends MessageHeader {
  kind: 'set-config';
  interfaceVersionMajor: number;
  interfaceVersionMinor: number;
  driveAddress: number;
  configurationFlags: DecodedConfigurationFlags;
  /** True when the message stops after byte 53, the firmware-independent form. */
  truncated: boolean;
  /** Byte 54, present only in the full-length message. */
  libraryInformationField?: number;
  /** Bytes 55..62, present only in the full-length message. */
  worldWideNodeName?: Buffer;
  raw: Buffer;
}

/**
 * Parses a Set_Config message.
 *
 * @throws {MessageParseError} If the message is not of type 0xAC, or is shorter
 * than the 54-byte firmware-independent form.
 */
export function parseSetConfig(message: Uint8Array): ParsedSetConfig {
  const header = parseHeader(message);

  if (header.msgType !== MessageType.SET_CONFIG) {
    throw new MessageParseError(
      `expected Msg Type 0xAC (Set_Config), ` +
        `received 0x${header.msgType.toString(16).padStart(2, '0').toUpperCase()}`,
    );
  }
  if (message.length < SET_CONFIG_TRUNCATED_LENGTH) {
    throw new MessageParseError(
      `Set_Config is ${message.length} bytes, shorter than the ${SET_CONFIG_TRUNCATED_LENGTH}-byte minimum`,
    );
  }

  const raw = Buffer.from(message);
  const truncated = raw.length < SET_CONFIG_FULL_LENGTH;

  const parsed: ParsedSetConfig = {
    kind: 'set-config',
    ...header,
    interfaceVersionMajor: raw[SetConfigOffset.INTERFACE_VERSION_MAJOR]!,
    interfaceVersionMinor: raw[SetConfigOffset.INTERFACE_VERSION_MINOR]!,
    driveAddress: raw[SetConfigOffset.DRIVE_ADDRESS]!,
    configurationFlags: decodeConfigurationFlags(raw[SetConfigOffset.CONFIGURATION_FLAGS]!),
    truncated,
    raw,
  };

  if (raw.length > SetConfigOffset.LIBRARY_INFORMATION_FIELD) {
    parsed.libraryInformationField = raw[SetConfigOffset.LIBRARY_INFORMATION_FIELD]!;
  }
  if (raw.length >= SetConfigOffset.WORLD_WIDE_NODE_NAME + WORLD_WIDE_NODE_NAME_LENGTH) {
    parsed.worldWideNodeName = Buffer.from(
      raw.subarray(
        SetConfigOffset.WORLD_WIDE_NODE_NAME,
        SetConfigOffset.WORLD_WIDE_NODE_NAME + WORLD_WIDE_NODE_NAME_LENGTH,
      ),
    );
  }

  return parsed;
}

/**
 * Lists the changes that make the drive reset itself, per the Interface
 * Scenarios tables. Clearing bit 3 is one of them, which is why the drive
 * reboots after being switched to standalone mode.
 */
export const FIELDS_CAUSING_DRIVE_RESET = [
  'Drive FC/SCSI Address (no reset within 10 seconds of power-on reset)',
  'Drive Fibre Channel World Wide Node Name',
  'Configuration Flags bit 3, Disable automatic drive online',
  'first-ever receipt of Set_Config for any drive model',
] as const;

/** Renders the Configuration Flags byte as a multi-line report. */
export function formatConfigurationFlags(flags: DecodedConfigurationFlags, indent = '  '): string {
  const line = (bit: number, name: string, meaning: string): string =>
    `${indent}bit ${bit} ${((flags.value >> bit) & 1) === 1 ? '1' : '0'}  ${name.padEnd(34)} ${meaning}`;

  return [
    line(
      ConfigurationFlagBit.NON_POLLED_MODE,
      'Non-Polled Mode',
      flags.nonPolledMode ? 'LDI operates in non-polled mode' : 'LDI operates in polled mode',
    ),
    line(
      ConfigurationFlagBit.DISABLE_SOFTLOAD,
      'Disable Softload',
      flags.disableSoftload ? 'softload disabled' : 'softload enabled',
    ),
    line(
      ConfigurationFlagBit.DISABLE_SCSI_EJECT,
      'Disable SCSI Eject',
      flags.disableScsiEject ? 'eject on SCSI Unload disabled' : 'eject on SCSI Unload enabled',
    ),
    line(
      ConfigurationFlagBit.DISABLE_AUTO_EJECT_FMR_OR_CLEANER,
      'Disable auto eject FMR/cleaner',
      flags.disableAutoEjectFmrOrCleaner ? 'automatic eject disabled' : 'automatic eject enabled',
    ),
    line(
      ConfigurationFlagBit.DISABLE_AUTOMATIC_DRIVE_ONLINE,
      'Disable automatic drive online',
      flags.disableAutomaticDriveOnline
        ? 'drive requires a Set_Config to go online (library mode)'
        : 'drive goes online automatically (standalone mode)',
    ),
    `${indent}bits 2-0   Reserved                           0x${flags.reserved.toString(16).toUpperCase()}`,
  ].join('\n');
}

/** Renders a Set_Config as a multi-line report. */
export function formatSetConfig(config: ParsedSetConfig): string {
  const lines = [
    `Set_Config (Library-to-Drive, Type=0xAC)${config.truncated ? ' - 54-byte firmware-independent form' : ''}`,
    `  Msg Type           : 0x${hex(config.msgType)} (Set_Config)`,
    `  Tgt Addr           : 0x${hex(config.tgtAddr)} ${config.tgtAddr === LIBRARY_LDI_ADDRESS ? '(library)' : `(drive ${config.tgtAddr})`}`,
    `  Msg ID             : ${formatHexBytes(config.msgId)}`,
    `  Interface Version  : ${config.interfaceVersionMajor}.${config.interfaceVersionMinor}`,
    `  Drive FC/SCSI Addr : ${config.driveAddress}`,
    `  Configuration Flags: 0x${hex(config.configurationFlags.value)}`,
    formatConfigurationFlags(config.configurationFlags, '    '),
  ];

  if (config.libraryInformationField !== undefined) {
    lines.push(`  Library Info Field : 0x${hex(config.libraryInformationField)}`);
  }
  if (config.worldWideNodeName) {
    const wwnn = formatHexBytes(config.worldWideNodeName);
    const isZero = config.worldWideNodeName.every((byte) => byte === 0);
    lines.push(`  Drive FC WWNN      : ${wwnn}${isZero ? ' (drive uses its own world wide names)' : ''}`);
  }

  return lines.join('\n');
}

function hex(byte: number): string {
  return byte.toString(16).padStart(2, '0').toUpperCase();
}

function formatHexBytes(bytes: Uint8Array): string {
  return [...bytes].map(hex).join(' ');
}
