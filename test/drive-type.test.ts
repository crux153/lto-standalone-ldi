/**
 * The Drive Type Request / Drive Type primitives.
 *
 * The GitHub write-up uses this exchange to find the drive's transmit pair:
 * "If we send just hex 00 to the drive, we should receive something with
 * 'I' 'B' 'M'."
 */

import { describe, expect, it } from 'vitest';

import {
  describeDriveTypeMismatches,
  DRIVE_TYPE_REQUEST,
  formatDriveType,
  parseDriveType,
} from '../src/messages/drive-type.js';
import { MessageParseError } from '../src/messages/header.js';

/** A response as an IBM LTO drive sends it, with firmware revision "K9A0". */
const IBM_RESPONSE = Buffer.from([0xfa, 0x49, 0x42, 0x4d, 0x80, 0x4b, 0x39, 0x41, 0x30]);

describe('Drive Type Request', () => {
  it('is a single 0x00 byte, sent outside the packet protocol', () => {
    // No STX, length, checksum, ETX, acknowledgement or byte stuffing.
    expect([...DRIVE_TYPE_REQUEST]).toEqual([0x00]);
  });
});

describe('parseDriveType', () => {
  it('accepts the 9-byte IBM response and confirms the vendor', () => {
    const driveType = parseDriveType(IBM_RESPONSE);

    expect(driveType.header).toBe(0xfa);
    expect(driveType.vendor).toBe('IBM');
    expect(driveType.deviceByte).toBe(0x80);
    expect(driveType.isIbmDrive).toBe(true);
    expect(describeDriveTypeMismatches(driveType)).toEqual([]);
  });

  it('reads the ASCII bytes 0x49 0x42 0x4D as "IBM"', () => {
    // Spec bytes 1-3 are literally ASCII 'I', 'B', 'M'.
    expect(Buffer.from('IBM', 'ascii').equals(IBM_RESPONSE.subarray(1, 4))).toBe(true);
  });

  it('exposes the firmware revision as bytes, an integer and ASCII', () => {
    const driveType = parseDriveType(IBM_RESPONSE);

    expect([...driveType.firmwareRevision]).toEqual([0x4b, 0x39, 0x41, 0x30]);
    expect(driveType.firmwareRevisionValue).toBe(0x4b394130);
    expect(driveType.firmwareRevisionAscii).toBe('K9A0');
  });

  it('omits the ASCII rendering when the revision is not printable', () => {
    const binaryRevision = Buffer.from([0xfa, 0x49, 0x42, 0x4d, 0x80, 0x00, 0x01, 0x02, 0x03]);
    const driveType = parseDriveType(binaryRevision);

    expect(driveType.firmwareRevisionAscii).toBeUndefined();
    expect(driveType.firmwareRevisionValue).toBe(0x00010203);
    expect(driveType.isIbmDrive).toBe(true);
  });

  it('does not claim an IBM drive when the vendor bytes differ', () => {
    const hp = Buffer.from([0xfa, 0x48, 0x50, 0x20, 0x80, 0x00, 0x00, 0x00, 0x00]);
    const driveType = parseDriveType(hp);

    expect(driveType.vendor).toBe('HP ');
    expect(driveType.isIbmDrive).toBe(false);
    expect(describeDriveTypeMismatches(driveType)).toEqual([
      'bytes 1-3 are "HP ", expected "IBM"',
    ]);
  });

  it('reports every mismatching field at once', () => {
    const garbage = Buffer.alloc(9);
    const problems = describeDriveTypeMismatches(parseDriveType(garbage));

    expect(problems).toHaveLength(2); // header byte and vendor
    expect(problems[0]).toMatch(/byte 0 is 0x00, expected 0xFA/);
    expect(problems[1]).toMatch(/bytes 1-3 are "\\u0000\\u0000\\u0000", expected "IBM"/);
  });

  it('reads byte 4 of 0x80 as the value the specification fixes', () => {
    const driveType = parseDriveType(IBM_RESPONSE);

    expect(driveType.deviceByte).toBe(0x80);
    expect(driveType.ltoGeneration).toBeUndefined();
    expect(driveType.deviceByteDescription).toContain('2002 specification');
  });

  it('requires exactly nine bytes', () => {
    expect(() => parseDriveType(IBM_RESPONSE.subarray(0, 8))).toThrow(MessageParseError);
    expect(() => parseDriveType(Buffer.concat([IBM_RESPONSE, Buffer.from([0x00])]))).toThrow(
      /exactly 9 bytes/,
    );
  });
});

describe('real hardware capture: IBM LTO-7 half-height, firmware M571', () => {
  // Captured from an IBM LTO-7 HH drive over a USB-to-RS-422 adapter. Byte 4 is
  // 0x37, not the 0x80 the 2002 specification gives, because drives newer than
  // Ultrium 1 report their generation there. Read as ASCII the tail of the
  // response is "IBM" "7" "M571", and IBM's own release notes pair firmware
  // M570 with LTO-7 full-height and M571 with LTO-7 half-height, so the two
  // readings agree.
  const LTO7_RESPONSE = Buffer.from([0xfa, 0x49, 0x42, 0x4d, 0x37, 0x4d, 0x35, 0x37, 0x31]);

  it('identifies the drive as IBM', () => {
    const driveType = parseDriveType(LTO7_RESPONSE);

    expect(driveType.header).toBe(0xfa);
    expect(driveType.vendor).toBe('IBM');
    expect(driveType.isIbmDrive).toBe(true);
    expect(describeDriveTypeMismatches(driveType)).toEqual([]);
  });

  it('decodes byte 4 as the LTO generation', () => {
    const driveType = parseDriveType(LTO7_RESPONSE);

    expect(driveType.deviceByte).toBe(0x37);
    expect(driveType.ltoGeneration).toBe(7);
    expect(driveType.deviceByteDescription).toBe("LTO generation 7 (ASCII '7')");
  });

  it('reads the firmware revision as M571', () => {
    expect(parseDriveType(LTO7_RESPONSE).firmwareRevisionAscii).toBe('M571');
  });

  it('reports the whole tail as readable ASCII', () => {
    expect(LTO7_RESPONSE.subarray(1).toString('ascii')).toBe('IBM7M571');
  });

  it('passes the verdict instead of failing on byte 4', () => {
    const report = formatDriveType(parseDriveType(LTO7_RESPONSE));

    expect(report).toContain('OK - drive identifies itself as IBM, LTO-7');
    expect(report).not.toContain('MISMATCH');
    expect(report).toContain("0x37 - LTO generation 7 (ASCII '7')");
  });

  it('accepts every LTO generation digit', () => {
    for (let generation = 1; generation <= 9; generation++) {
      const response = Buffer.from([0xfa, 0x49, 0x42, 0x4d, 0x30 + generation, 0, 0, 0, 0]);
      const driveType = parseDriveType(response);
      expect(driveType.isIbmDrive).toBe(true);
      expect(driveType.ltoGeneration).toBe(generation);
    }
  });

  it('still identifies an IBM drive when byte 4 is neither form', () => {
    const odd = Buffer.from([0xfa, 0x49, 0x42, 0x4d, 0xaa, 0, 0, 0, 0]);
    const driveType = parseDriveType(odd);

    expect(driveType.isIbmDrive).toBe(true);
    expect(driveType.ltoGeneration).toBeUndefined();
    expect(driveType.deviceByteDescription).toBe('unrecognised');
    expect(formatDriveType(driveType)).toContain('does not affect');
  });
});

describe('formatDriveType', () => {
  it('says the drive identified itself as IBM', () => {
    const report = formatDriveType(parseDriveType(IBM_RESPONSE));

    expect(report).toContain('"IBM"');
    expect(report).toContain('OK - drive identifies itself as IBM');
    expect(report).toContain('FA 49 42 4D 80 4B 39 41 30');
  });

  it('lists the reasons when the response is not an IBM drive', () => {
    const report = formatDriveType(parseDriveType(Buffer.alloc(9)));

    expect(report).toContain('MISMATCH');
    expect(report).toContain('expected 0xFA');
  });
});
