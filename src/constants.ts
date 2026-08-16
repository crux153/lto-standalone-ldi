/**
 * Protocol constants for the IBM Library/Drive Interface (LDI).
 *
 * All references in this file are to the "IBM Library/Drive Interface
 * Specification", Revision 4, January 8 2002, published to the T10 committee
 * as T10/02-022r0 (https://www.t10.org/ftp/t10/document.02/02-022r0.pdf).
 */

/** ASCII control characters used by the packet protocol (spec Table 1). */
export const ControlCharacter = {
  /** Start of Text - beginning of packet text. */
  STX: 0x02,
  /** End of Text - end of packet text. Terminates every packet, including ACK/NAK/SNAK. */
  ETX: 0x03,
  /** Positive acknowledgement: packet received, ready for the next packet. */
  ACK: 0x06,
  /** Negative acknowledgement: checksum or message-length error; sender retries. */
  NAK: 0x15,
  /** Special negative acknowledgement: receiver too busy; retry after 10 seconds. */
  SNAK: 0x1a,
} as const;

/**
 * Message types (spec Table 2).
 *
 * Only two types exist so that LDI can co-exist with legacy IBM library/drive
 * interfaces. `TWO_WAY` is further divided into subtypes.
 */
export const MessageType = {
  /** Two_Way: byte 6 of the message carries a {@link MessageSubtype}. */
  TWO_WAY: 0xab,
  /** Set_Config: library configuration information, library-to-drive only. */
  SET_CONFIG: 0xac,
} as const;

/** Two_Way message subtypes (spec Table 3). */
export const MessageSubtype = {
  /** Drive-to-library request for library configuration; starts the handshake. */
  CONFIG_REQUEST: 0x01,
  /** Library-to-drive request for a drive operation, identity, status, log or firmware. */
  MAINT_COMMAND: 0x30,
  /** Drive-to-library non-error response to a Maint_Command, with optional data. */
  MAINT_STATUS_GOOD: 0x3c,
  /** Drive-to-library error response to a Maint_Command, carrying SCSI sense data. */
  MAINT_STATUS_ERROR: 0x3f,
  /** Drive-to-library status, sent asynchronously or in response to Drive_Status_Request. */
  DRIVE_STATUS: 0x40,
  /** Library-to-drive request for drive status. */
  DRIVE_STATUS_REQUEST: 0x41,
} as const;

/** Maintenance sub-commands carried in byte 7 of a Maint_Command message. */
export const MaintSubCommand = {
  DEVICE_OFFLINE: 0x00,
  DEVICE_ONLINE: 0x01,
  READ_STANDARD_INQUIRY_DATA: 0x10,
  READ_REQUEST_SENSE_DATA: 0x11,
  READ_DEVICE_IDENTIFICATION_DATA: 0x12,
  SET_DRIVE_SERIAL_NUMBER: 0x20,
  UNLOAD_DRIVE: 0x30,
  LOAD_DRIVE: 0x31,
  PERFORM_READ_WRITE_TEST: 0x50,
  PERFORM_HEAD_TEST: 0x51,
  PERFORM_MEDIA_TEST: 0x52,
  SHORT_READ_WRITE_DIAGNOSTIC: 0x53,
  PERFORM_SELF_TEST: 0x55,
  FIRMWARE_UPDATE_FROM_FMR_CARTRIDGE: 0x60,
  CREATE_DRIVE_FMR_CARTRIDGE: 0x61,
  ERASE_DRIVE_FMR_CARTRIDGE: 0x62,
  READ_BUFFER: 0x63,
  WRITE_BUFFER: 0x64,
  READ_TAPE: 0x65,
  WRITE_TAPE: 0x66,
  WRITE_DRIVE_DUMP_TO_TAPE: 0x70,
  FORCE_DRIVE_DUMP: 0x71,
  RESET_DRIVE: 0x80,
  FORCE_CHECK_ONE_DUMP_AND_RESET_DRIVE: 0x81,
  SCSI_WRAP_TEST: 0x90,
  SETUP_FORCED_ERROR_LOGGING: 0xb0,
  READ_LOG_SENSE_DATA: 0xb5,
  SET_TRAPS: 0xc0,
  REMOVE_TRAPS: 0xc1,
} as const;

/**
 * LDI address of the tape library. When the library is the target of a message
 * the address is always 0xFF (spec, "Tgt Addr" legend of Figure 4).
 */
export const LIBRARY_LDI_ADDRESS = 0xff;

/** Lowest valid LDI address for a drive. */
export const MIN_DRIVE_LDI_ADDRESS = 0x01;

/** Highest valid LDI address for a drive. */
export const MAX_DRIVE_LDI_ADDRESS = 0xfe;

/**
 * The message header (Msg Type, Tgt Addr, Msg ID) occupies bytes 0..5 of every
 * message, so no message can be shorter than this (spec Figure 4).
 */
export const MESSAGE_HEADER_LENGTH = 6;

/** Smallest legal message length before byte stuffing (spec Figure 2). */
export const MIN_MESSAGE_LENGTH = 6;

/** Largest legal message length before byte stuffing (spec Figure 2). */
export const MAX_MESSAGE_LENGTH = 507;

/**
 * Drive Type Request primitive: a single 0x00 byte sent library-to-drive.
 *
 * This is one of only two exchanges that happen *outside* the packet protocol,
 * so it carries no STX, length, BCC, ETX, acknowledgement or byte stuffing
 * (spec, "Primitives").
 */
export const DRIVE_TYPE_REQUEST_BYTE = 0x00;

/** A Drive Type response is a fixed 9-byte sequence (spec, "Primitives"). */
export const DRIVE_TYPE_RESPONSE_LENGTH = 9;

/** Byte 0 of a Drive Type response. */
export const DRIVE_TYPE_HEADER_BYTE = 0xfa;

/** Bytes 1..3 of a Drive Type response: ASCII 'I', 'B', 'M'. */
export const DRIVE_TYPE_VENDOR_ID = 'IBM';

/**
 * Byte 4 of a Drive Type response as the specification defines it.
 *
 * The document dates from 2002, when Ultrium 1 was the only generation, and
 * fixes this byte at 0x80. Later drives report their LTO generation here as an
 * ASCII digit instead: an LTO-7 half-height drive running firmware M571 answers
 * `FA 49 42 4D 37 4D 35 37 31`, whose tail reads as ASCII "IBM" "7" "M571".
 * Identification therefore rests on byte 0 and the vendor field alone.
 */
export const DRIVE_TYPE_DEVICE_BYTE = 0x80;

/**
 * Serial line settings for the LDI (spec, "LDI Electrical Characteristics").
 *
 * The drive supports 9600 or 38400 baud and 1 or 2 stop bits, both selected by
 * feature (DIP) switches on the drive. 38400 8N1 is the default used by the
 * IBM LTO drives this tool targets.
 */
export const DEFAULT_SERIAL_OPTIONS = {
  baudRate: 38400,
  dataBits: 8,
  parity: 'none',
  stopBits: 1,
} as const;

/** Baud rates the drive is able to run at. */
export const SUPPORTED_BAUD_RATES = [9600, 38400] as const;

/**
 * Timing values used by the IBM tape drive implementation. The spec notes that
 * both the library and the drive have discretion over these values; these are
 * the ones the drive itself uses (spec, "Sending Packets").
 */
export const Timing = {
  /** Time to wait for an ACK/NAK/SNAK after the last byte of a packet was sent. */
  SEND_TIMEOUT_MS: 5_000,
  /** Number of resends attempted after a timeout or a NAK. */
  SEND_RETRIES: 3,
  /** Delay before resending after a SNAK. */
  SNAK_RETRY_DELAY_MS: 10_000,
  /** Number of resends attempted after a SNAK. */
  SNAK_RETRIES: 10,
  /**
   * The spec's suggested receive timeout for packet completion, measured from
   * the first character of a packet.
   *
   * Note that the spec contradicts itself here: it offers 10 seconds as "a
   * possible timeout value" while also stating that the receive timeout should
   * be less than the send timeout, which is 5 seconds. The value below is the
   * one the spec names outright; a receiver that enforces a timeout should pick
   * something under {@link SEND_TIMEOUT_MS} instead.
   *
   * Nothing in this library enforces a receive timeout. The IBM drive does not
   * implement one either: it returns no response to a partial packet until a
   * later ETX arrives, at which point the length mismatch produces a NAK.
   */
  RECEIVE_TIMEOUT_MS: 10_000,
  /**
   * A drive in non-polled mode issues its Config_Request within ten seconds of
   * power-up or reset (spec, "Config_Request").
   */
  CONFIG_REQUEST_WINDOW_MS: 10_000,
} as const;
