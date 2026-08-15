import { describe, expect, it } from 'vitest';

import { decodeMessage } from '../src/messages/decode.js';
import {
  decodeTapeAlertFlags,
  DRIVE_STATUS_LENGTH,
  formatDriveStatus,
  isDriveStatus,
  parseDriveStatus,
} from '../src/messages/drive-status.js';

/** Builds a 32-byte Drive_Status message with the given field overrides. */
function driveStatus(overrides: Partial<Record<number, number>> = {}): Buffer {
  const message = Buffer.alloc(DRIVE_STATUS_LENGTH);
  message[0] = 0xab; // Msg Type
  message[1] = 0xff; // Tgt Addr: the library
  message[5] = 0x01; // Msg ID
  message[6] = 0x40; // Msg Subtype: Drive_Status
  message[8] = 0x17; // Additional Status Length
  for (const [offset, value] of Object.entries(overrides)) {
    message[Number(offset)] = value!;
  }
  return message;
}

describe('parseDriveStatus', () => {
  it('decodes an idle drive with no cartridge', () => {
    // Flags 1 = 0x80: cartridge not loaded, nothing else set.
    const status = parseDriveStatus(driveStatus({ 7: 0x80 }));

    expect(status.kind).toBe('drive-status');
    expect(status.flags1.cartridgeNotLoaded).toBe(true);
    expect(status.flags1.cartridgePresent).toBe(false);
    expect(status.cartridgePosition).toBe('not-present');
    expect(status.additionalStatusLength).toBe(0x17);
    expect(status.tapeMotionDescription).toBe('No current motion');
  });

  it('derives every documented cartridge position', () => {
    // The spec's table over bits 7, 2 and 0 of Drive Status Flags 1.
    expect(parseDriveStatus(driveStatus({ 7: 0b1000_0000 })).cartridgePosition).toBe('not-present');
    expect(parseDriveStatus(driveStatus({ 7: 0b1000_0100 })).cartridgePosition).toBe(
      'ejected-loadable',
    );
    expect(parseDriveStatus(driveStatus({ 7: 0b0000_0100 })).cartridgePosition).toBe(
      'cm-accessible-not-threaded',
    );
    expect(parseDriveStatus(driveStatus({ 7: 0b0000_0101 })).cartridgePosition).toBe(
      'loaded-and-threaded',
    );
  });

  it('decodes each Drive Status Flags 1 bit', () => {
    const status = parseDriveStatus(driveStatus({ 7: 0b0101_1101 }));

    expect(status.flags1.cartridgeNotLoaded).toBe(false);
    expect(status.flags1.driveCleanRequired).toBe(true);
    expect(status.flags1.writeProtectedCartridge).toBe(true);
    expect(status.flags1.compressionEnabled).toBe(true);
    expect(status.flags1.cartridgePresent).toBe(true);
    expect(status.flags1.lun0Ready).toBe(true);
  });

  it('decodes the display, LED and tape motion fields', () => {
    const status = parseDriveStatus(
      driveStatus({
        9: 0x43, // ASCII 'C'
        10: 0x02, // blinking at 2 Hz
        11: 0x01, // green
        12: 0x7f, // on solid
        13: 11, // rewinding
      }),
    );

    expect(status.displayCharacter).toBe('C');
    expect(status.displayCharacterRateDescription).toBe('Blinking at 2 Hz');
    expect(status.statusLedDescription).toBe('Green');
    expect(status.statusLedRateDescription).toBe('On solid, no blinking');
    expect(status.tapeMotionDescription).toBe('Rewinding');
  });

  it('reads the tape VolSer out of bytes 14..21', () => {
    const message = driveStatus();
    message.write('ABC123L6', 14, 'ascii');

    expect(parseDriveStatus(message).tapeVolSer).toBe('ABC123L6');
  });

  it('decodes Drive Status Flags 2 for a Fibre Channel drive', () => {
    const status = parseDriveStatus(driveStatus({ 30: 0b1000_1011 }));

    expect(status.flags2.fibreChannel).toBe(true);
    expect(status.flags2.offline).toBe(false);
    expect(status.flags2.hardAlpa).toBe(true);
    expect(status.flags2.lightDetected).toBe(true);
    expect(status.flags2.loopInitialized).toBe(true);
  });

  it('decodes POST state and cartridge type from Drive Status Flags 3', () => {
    const running = parseDriveStatus(driveStatus({ 31: 0b1000_0010 }));
    expect(running.flags3.postProcessing).toBe(true);
    expect(running.flags3.cartridgeTypeDescription).toBe('Cleaner cartridge');

    // POST complete is what tells a library the drive is ready in polled mode.
    const ready = parseDriveStatus(driveStatus({ 31: 0b0000_0001 }));
    expect(ready.flags3.postProcessing).toBe(false);
    expect(ready.flags3.cartridgeTypeDescription).toBe('Standard LTO Generation 1 format');
  });

  it('rejects a message that is not a Drive_Status', () => {
    expect(() => parseDriveStatus(driveStatus({ 6: 0x01 }))).toThrow(/expected Msg Subtype 0x40/);
    expect(() => parseDriveStatus(driveStatus({ 0: 0xac }))).toThrow(/expected Msg Type 0xAB/);
    expect(() => parseDriveStatus(driveStatus().subarray(0, 20))).toThrow(/shorter than/);
  });

  it('is recognised by isDriveStatus and dispatched by decodeMessage', () => {
    expect(isDriveStatus(driveStatus())).toBe(true);
    expect(decodeMessage(driveStatus()).kind).toBe('drive-status');
  });
});

describe('decodeTapeAlertFlags', () => {
  it('maps byte 22 bit 7 to flag 1 and byte 29 bit 0 to flag 64', () => {
    const first = Buffer.alloc(8);
    first[0] = 0b1000_0000;
    expect(decodeTapeAlertFlags(first)).toEqual([1]);

    const last = Buffer.alloc(8);
    last[7] = 0b0000_0001;
    expect(decodeTapeAlertFlags(last)).toEqual([64]);
  });

  it('returns an empty list when nothing is set', () => {
    expect(decodeTapeAlertFlags(Buffer.alloc(8))).toEqual([]);
  });

  it('lists every set flag in ascending order', () => {
    const bytes = Buffer.alloc(8);
    bytes[0] = 0b0100_0000; // flag 2
    bytes[2] = 0b0000_0001; // flag 24
    expect(decodeTapeAlertFlags(bytes)).toEqual([2, 24]);
  });
});

describe('formatDriveStatus', () => {
  it('renders the fields a user needs to see', () => {
    const message = driveStatus({ 7: 0b0000_0101, 11: 0x01, 30: 0x00, 31: 0x01 });
    message.write('TAPE01', 14, 'ascii');
    const report = formatDriveStatus(parseDriveStatus(message));

    expect(report).toContain('cartridge position           : Cartridge present, loaded and threaded');
    expect(report).toContain('communication type           : SCSI');
    expect(report).toContain('online                       : yes');
    expect(report).toContain('"TAPE01"');
    expect(report).toContain('POST processing              : complete');
  });
});
