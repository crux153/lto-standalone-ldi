#!/usr/bin/env node
/**
 * Command-line front end.
 *
 * `serialport` is imported lazily so that the offline commands - the ones that
 * only build or decode packets - keep working on a machine where the native
 * bindings are unavailable.
 */

import { parseArgs } from 'node:util';

import { DEFAULT_SERIAL_OPTIONS, SUPPORTED_BAUD_RATES, Timing } from './constants.js';
import { decodeMessage, formatMessage } from './messages/decode.js';
import { formatConfigRequest } from './messages/config-request.js';
import { formatDriveType } from './messages/drive-type.js';
import { formatDriveStatus } from './messages/drive-status.js';
import { buildSetConfig, buildSetConfigResponse, type SetConfigOptions } from './messages/set-config.js';
import { decodePacket, encodePacket } from './packet.js';
import { parseEscapedHex, REFERENCE_SET_CONFIG_PACKET } from './reference.js';
import { LdiSession, type LdiStream } from './session.js';

const USAGE = `lto-standalone-ldi - configure an IBM LTO drive for standalone operation over RS-422 LDI

Usage: lto-ldi <command> [options]

Commands
  list-ports                 List the serial ports this machine can see.
  drive-type                 Send a Drive Type Request (0x00) and verify the drive answers "IBM".
  monitor                    Decode and print everything the drive sends, including Config_Request.
  standalone                 Wait for a Config_Request, then answer with a Set_Config that clears
                             Configuration Flags bit 3 so the drive comes online by itself.
  set-config                 Send a Set_Config with explicit field values.
  build                      Print the Set_Config packet without touching any hardware.
  decode <hex>               Decode a captured packet given as hex bytes or \\xNN escapes.

Serial options (drive-type, monitor, standalone, set-config)
  -p, --port <path>          Serial device, e.g. /dev/ttyUSB0 or COM3. Required.
  -b, --baud <rate>          ${SUPPORTED_BAUD_RATES.join(' or ')}. Default ${DEFAULT_SERIAL_OPTIONS.baudRate}.
      --stop-bits <1|2>      Default ${DEFAULT_SERIAL_OPTIONS.stopBits}.

Set_Config options (standalone, set-config, build)
      --ldi-address <n>      Tgt Addr, the drive's LDI address, 1..254. Default 1.
      --drive-address <n>    Drive FC/SCSI address. SCSI 0..15, Fibre Channel Loop ID 0..127. Default 0.
      --library-mode         Set bit 3 instead of clearing it, putting the drive back under
                             library control so it stays offline until a Set_Config arrives.
      --non-polled           Set bit 7 so the drive may initiate LDI traffic.
      --disable-softload     Set bit 6.
      --disable-scsi-eject   Set bit 5.
      --disable-auto-eject   Set bit 4.
      --full                 Send all 64 bytes instead of the 54-byte firmware-independent form.
      --msg-id <hex>         Four Msg ID bytes, e.g. 00000001. Ignored when answering a Config_Request.

Other options
      --timeout <ms>         How long to wait for the drive. Default ${Timing.CONFIG_REQUEST_WINDOW_MS} for standalone.
      --async                standalone only: send the Set_Config immediately instead of waiting
                             for a Config_Request (the library-initiated handshake). With no other
                             options this sends the published reference packet byte for byte.
      --reference            build only: print the published reference packet for comparison.
  -h, --help                 Show this help.

Before you start
  Set every DIP switch on the drive to off so it comes up in non-polled mode and
  sends a Config_Request of its own accord.

Wiring (RS-422, ${DEFAULT_SERIAL_OPTIONS.baudRate} 8N1, drive-side JST-SH 1.0 mm 10-pin)
  pin 1 RX+   <- adapter TX+        pin 4 TX-   -> adapter RX-
  pin 2 RX-   <- adapter TX-        pin 5 TX+   -> adapter RX+
  pin 3 GND   <-> adapter GND
  Cross the pairs: the adapter transmits into the drive's receiver and vice versa.
`;

interface SerialSettings {
  path: string;
  baudRate: number;
  stopBits: 1 | 2;
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];

  if (!command || command === '-h' || command === '--help' || command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }

  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: {
      port: { type: 'string', short: 'p' },
      baud: { type: 'string', short: 'b' },
      'stop-bits': { type: 'string' },
      'ldi-address': { type: 'string' },
      'drive-address': { type: 'string' },
      'library-mode': { type: 'boolean' },
      'non-polled': { type: 'boolean' },
      'disable-softload': { type: 'boolean' },
      'disable-scsi-eject': { type: 'boolean' },
      'disable-auto-eject': { type: 'boolean' },
      full: { type: 'boolean' },
      'msg-id': { type: 'string' },
      timeout: { type: 'string' },
      async: { type: 'boolean' },
      reference: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  switch (command) {
    case 'list-ports':
      return listPorts();
    case 'build':
      return build(values);
    case 'decode':
      return decode(positionals);
    case 'drive-type':
      return driveType(values);
    case 'monitor':
      return monitor(values);
    case 'standalone':
      return standalone(values);
    case 'set-config':
      return setConfig(values);
    default:
      process.stderr.write(`unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
      return 2;
  }
}

type Values = Record<string, string | boolean | undefined>;

/** Collects the Set_Config field values from the parsed command line. */
function setConfigOptionsFrom(values: Values): SetConfigOptions {
  const options: SetConfigOptions = {
    tgtAddr: integerOption(values['ldi-address'], 'ldi-address', 1, 254) ?? 0x01,
    driveAddress: integerOption(values['drive-address'], 'drive-address', 0, 255) ?? 0,
    truncated: values.full !== true,
    flags: {
      // Clearing bit 3 is the point of this tool; --library-mode sets it again.
      disableAutomaticDriveOnline: values['library-mode'] === true,
      nonPolledMode: values['non-polled'] === true,
      disableSoftload: values['disable-softload'] === true,
      disableScsiEject: values['disable-scsi-eject'] === true,
      disableAutoEjectFmrOrCleaner: values['disable-auto-eject'] === true,
    },
  };

  const msgId = values['msg-id'];
  if (typeof msgId === 'string') {
    const bytes = Buffer.from(msgId.replace(/[\s:]/g, ''), 'hex');
    if (bytes.length !== 4) {
      throw new UsageError(`--msg-id must be exactly four hex bytes, received ${JSON.stringify(msgId)}`);
    }
    options.msgId = bytes;
  }

  return options;
}

function build(values: Values): number {
  if (values.reference) {
    process.stdout.write(
      `Published reference packet (${REFERENCE_SET_CONFIG_PACKET.length} bytes)\n` +
        `  ${formatHexBytes(REFERENCE_SET_CONFIG_PACKET)}\n\n`,
    );
    const decoded = decodePacket(REFERENCE_SET_CONFIG_PACKET);
    if (decoded.kind === 'packet') {
      process.stdout.write(`${formatMessage(decodeMessage(decoded.message))}\n`);
    }
    return 0;
  }

  const message = buildSetConfig(setConfigOptionsFrom(values));
  const packet = encodePacket(message);

  process.stdout.write(
    [
      `Message (${message.length} bytes, before byte stuffing)`,
      `  ${formatHexBytes(message)}`,
      '',
      `Packet (${packet.length} bytes, on the wire)`,
      `  ${formatHexBytes(packet)}`,
      '',
      'Shell-escaped form',
      `  ${[...packet].map((byte) => `\\x${byte.toString(16).padStart(2, '0').toUpperCase()}`).join('')}`,
      '',
      formatMessage(decodeMessage(message)),
      '',
    ].join('\n'),
  );
  return 0;
}

function decode(positionals: string[]): number {
  const input = positionals.join(' ').trim();
  if (!input) {
    throw new UsageError('decode needs a packet, e.g. lto-ldi decode "02 00 36 AC ..."');
  }

  const bytes = input.includes('\\x')
    ? parseEscapedHex(input)
    : Buffer.from(input.replace(/[\s:,]|0x/gi, ''), 'hex');

  if (bytes.length === 0) {
    throw new UsageError('could not read any bytes from the input');
  }

  process.stdout.write(`Input (${bytes.length} bytes)\n  ${formatHexBytes(bytes)}\n\n`);

  const result = decodePacket(bytes);
  if (result.kind === 'error') {
    process.stderr.write(`Packet is invalid (${result.reason}): ${result.message}\n`);
    return 1;
  }

  process.stdout.write(
    `Message (${result.message.length} bytes, unstuffed)\n  ${formatHexBytes(result.message)}\n\n` +
      `${formatMessage(decodeMessage(result.message))}\n`,
  );
  return 0;
}

async function listPorts(): Promise<number> {
  const { SerialPort } = await import('serialport');

  let ports: Awaited<ReturnType<typeof SerialPort.list>>;
  try {
    ports = await SerialPort.list();
  } catch (error) {
    // Enumeration leans on platform tools such as udevadm, which a minimal
    // container may not have. Naming the port directly still works.
    process.stderr.write(
      `could not enumerate serial ports: ${error instanceof Error ? error.message : String(error)}\n` +
        'Pass the device path directly with --port instead.\n',
    );
    return 1;
  }

  if (ports.length === 0) {
    process.stdout.write('No serial ports found.\n');
    return 0;
  }

  for (const port of ports) {
    const details = [port.manufacturer, port.serialNumber, port.pnpId].filter(Boolean).join(' | ');
    process.stdout.write(`${port.path}${details ? `  (${details})` : ''}\n`);
  }
  return 0;
}

async function openPort(values: Values): Promise<{ stream: LdiStream; close: () => Promise<void> }> {
  const settings = serialSettingsFrom(values);
  const { SerialPort } = await import('serialport');

  const port = new SerialPort({
    path: settings.path,
    baudRate: settings.baudRate,
    dataBits: 8,
    parity: 'none',
    stopBits: settings.stopBits,
    autoOpen: false,
  });

  await new Promise<void>((resolve, reject) => {
    port.open((error) => (error ? reject(error) : resolve()));
  });

  return {
    stream: port as unknown as LdiStream,
    close: () =>
      new Promise<void>((resolve) => {
        port.close(() => resolve());
      }),
  };
}

async function driveType(values: Values): Promise<number> {
  const { stream, close } = await openPort(values);
  const session = new LdiSession(stream);
  const timeout = integerOption(values.timeout, 'timeout', 1, 600_000) ?? 3_000;

  try {
    process.stdout.write('Sending Drive Type Request (0x00)...\n');
    const result = await session.requestDriveType(timeout);
    process.stdout.write(`${formatDriveType(result)}\n`);
    return result.isIbmDrive ? 0 : 1;
  } finally {
    session.close();
    await close();
  }
}

async function monitor(values: Values): Promise<number> {
  const { stream, close } = await openPort(values);
  const session = new LdiSession(stream);

  process.stdout.write('Listening. Power-cycle the drive to see its Config_Request. Ctrl-C to stop.\n\n');

  session.on('message', (message, raw) => {
    process.stdout.write(`<- packet (${raw.length} bytes) ${formatHexBytes(raw)}\n`);
    process.stdout.write(`${formatMessage(message)}\n\n`);
  });
  session.on('packet-error', (error) => {
    process.stderr.write(`<- invalid packet (${error.reason}): ${error.message}\n`);
    process.stderr.write(`   ${formatHexBytes(error.raw)}\n\n`);
  });
  session.on('discarded', (bytes) => {
    // The drive emits a self-test byte sequence before power-on reset finishes;
    // the spec requires a receiver to throw those bytes away.
    process.stdout.write(`<- ${bytes.length} non-packet byte(s) ignored: ${formatHexBytes(bytes)}\n`);
  });
  session.on('response', (kind) => {
    process.stdout.write(`<- ${kind.toUpperCase()}\n`);
  });
  session.on('error', (error) => {
    process.stderr.write(`error: ${error.message}\n`);
  });

  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve());
  });

  session.close();
  await close();
  process.stdout.write('\nStopped.\n');
  return 0;
}

async function standalone(values: Values): Promise<number> {
  const { stream, close } = await openPort(values);
  const session = new LdiSession(stream);
  const timeout = integerOption(values.timeout, 'timeout', 1, 600_000) ?? Timing.CONFIG_REQUEST_WINDOW_MS;
  const options = setConfigOptionsFrom(values);

  session.on('discarded', (bytes) => {
    process.stdout.write(`   (ignored ${bytes.length} non-packet byte(s): ${formatHexBytes(bytes)})\n`);
  });

  try {
    let message: Buffer;

    if (values.async) {
      // Library-initiated handshake: send Set_Config without being asked.
      process.stdout.write('Sending an unsolicited Set_Config (library-initiated handshake).\n');
      message = buildSetConfig(options);
    } else {
      process.stdout.write(
        `Waiting up to ${timeout} ms for a Config_Request.\n` +
          'Power-cycle the drive now if it is already running.\n\n',
      );
      const request = await session.waitForConfigRequest(timeout);
      process.stdout.write(`${formatConfigRequest(request)}\n\n`);
      // The four Msg ID bytes of the reply must match the request exactly.
      message = buildSetConfigResponse(request, options);
    }

    const packet = encodePacket(message);
    process.stdout.write(
      `Sending Set_Config\n` +
        `  message (${message.length} bytes): ${formatHexBytes(message)}\n` +
        `  packet  (${packet.length} bytes): ${formatHexBytes(packet)}\n\n` +
        `${formatMessage(decodeMessage(message))}\n\n`,
    );

    await session.sendPacket(packet);
    process.stdout.write('Drive acknowledged the Set_Config (ACK).\n');

    if (options.flags?.disableAutomaticDriveOnline === false) {
      process.stdout.write(
        '\nConfiguration Flags bit 3 is now clear, so the drive will bring its SCSI or\n' +
          'Fibre Channel port up by itself from now on. Changing that bit makes the drive\n' +
          'reset itself, which takes up to a minute; the drive may repeat the handshake\n' +
          'once it comes back.\n',
      );
    }

    // In non-polled mode a drive that did not need to reset reports its status.
    try {
      const status = await session.waitForDriveStatus(5_000);
      process.stdout.write(`\n${formatDriveStatus(status)}\n`);
    } catch {
      process.stdout.write(
        '\nNo Drive_Status followed, which is expected when the drive is resetting or\n' +
          'when the LDI is in polled mode.\n',
      );
    }

    return 0;
  } finally {
    session.close();
    await close();
  }
}

async function setConfig(values: Values): Promise<number> {
  const { stream, close } = await openPort(values);
  const session = new LdiSession(stream);

  try {
    const message = buildSetConfig(setConfigOptionsFrom(values));
    const packet = encodePacket(message);

    process.stdout.write(
      `Sending Set_Config\n  ${formatHexBytes(packet)}\n\n${formatMessage(decodeMessage(message))}\n\n`,
    );
    await session.sendPacket(packet);
    process.stdout.write('Drive acknowledged the Set_Config (ACK).\n');
    return 0;
  } finally {
    session.close();
    await close();
  }
}

function serialSettingsFrom(values: Values): SerialSettings {
  const path = values.port;
  if (typeof path !== 'string' || path.length === 0) {
    throw new UsageError('--port is required, e.g. --port /dev/ttyUSB0');
  }

  const baudRate = integerOption(values.baud, 'baud', 1, 4_000_000) ?? DEFAULT_SERIAL_OPTIONS.baudRate;
  if (!SUPPORTED_BAUD_RATES.includes(baudRate as (typeof SUPPORTED_BAUD_RATES)[number])) {
    process.stderr.write(
      `warning: the drive supports ${SUPPORTED_BAUD_RATES.join(' and ')} baud; using ${baudRate}\n`,
    );
  }

  const stopBits = integerOption(values['stop-bits'], 'stop-bits', 1, 2) ?? DEFAULT_SERIAL_OPTIONS.stopBits;

  return { path, baudRate, stopBits: stopBits as 1 | 2 };
}

function integerOption(
  value: string | boolean | undefined,
  name: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || typeof value === 'boolean') return undefined;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new UsageError(`--${name} must be an integer in ${min}..${max}, received ${JSON.stringify(value)}`);
  }
  return parsed;
}

function formatHexBytes(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

/** A problem with the command line rather than with the drive. */
class UsageError extends Error {}

const exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  return 1;
});

process.exitCode = exitCode;
