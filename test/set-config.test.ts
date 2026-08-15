import { describe, expect, it } from 'vitest';

import {
  buildSetConfig,
  buildSetConfigResponse,
  decodeConfigurationFlags,
  encodeConfigurationFlags,
  parseSetConfig,
  SET_CONFIG_FULL_LENGTH,
  SET_CONFIG_TRUNCATED_LENGTH,
  SetConfigOffset,
} from '../src/messages/set-config.js';
import { encodePacket } from '../src/packet.js';

describe('configuration flags', () => {
  it('places each flag on the bit the spec assigns it', () => {
    expect(encodeConfigurationFlags({ nonPolledMode: true })).toBe(0b1000_0000);
    expect(encodeConfigurationFlags({ disableSoftload: true })).toBe(0b0100_0000);
    expect(encodeConfigurationFlags({ disableScsiEject: true })).toBe(0b0010_0000);
    expect(encodeConfigurationFlags({ disableAutoEjectFmrOrCleaner: true })).toBe(0b0001_0000);
    expect(encodeConfigurationFlags({ disableAutomaticDriveOnline: true })).toBe(0b0000_1000);
  });

  it('defaults to a zero byte, which is standalone mode', () => {
    expect(encodeConfigurationFlags()).toBe(0x00);
    expect(decodeConfigurationFlags(0x00).disableAutomaticDriveOnline).toBe(false);
  });

  it('round-trips every byte value', () => {
    for (let value = 0; value < 256; value++) {
      const decoded = decodeConfigurationFlags(value);
      // The low three bits are reserved and are not part of the named flags.
      expect(encodeConfigurationFlags(decoded)).toBe(value & 0b1111_1000);
      expect(decoded.reserved).toBe(value & 0b111);
    }
  });

  it('rejects values outside a byte', () => {
    expect(() => decodeConfigurationFlags(256)).toThrow(RangeError);
    expect(() => decodeConfigurationFlags(-1)).toThrow(RangeError);
  });
});

describe('buildSetConfig', () => {
  it('emits the 54-byte firmware-independent form by default', () => {
    // The spec's Interface Scenarios recommend always starting with bytes 0-53,
    // which every drive firmware level accepts.
    expect(buildSetConfig().length).toBe(SET_CONFIG_TRUNCATED_LENGTH);
    expect(buildSetConfig({ truncated: false }).length).toBe(SET_CONFIG_FULL_LENGTH);
  });

  it('lays the fields out at the offsets the spec defines', () => {
    const message = buildSetConfig({
      truncated: false,
      tgtAddr: 0x07,
      msgId: Uint8Array.from([0xff, 0xde, 0xad, 0xbe]),
      driveAddress: 12,
      libraryInformationField: 0x5a,
      worldWideNodeName: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
      flags: { disableAutomaticDriveOnline: true, nonPolledMode: true },
    });

    expect(message[0]).toBe(0xac);
    expect(message[1]).toBe(0x07);
    expect([...message.subarray(2, 6)]).toEqual([0xff, 0xde, 0xad, 0xbe]);
    expect(message[SetConfigOffset.INTERFACE_VERSION_MAJOR]).toBe(0x02);
    expect(message[SetConfigOffset.INTERFACE_VERSION_MINOR]).toBe(0x00);
    expect(message[SetConfigOffset.DRIVE_ADDRESS]).toBe(12);
    expect(message[SetConfigOffset.CONFIGURATION_FLAGS]).toBe(0b1000_1000);
    expect(message[SetConfigOffset.LIBRARY_INFORMATION_FIELD]).toBe(0x5a);
    expect([...message.subarray(SetConfigOffset.WORLD_WIDE_NODE_NAME, 63)]).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(message[63]).toBe(0x00); // reserved
  });

  it('leaves the reserved ranges zeroed', () => {
    const message = buildSetConfig({ truncated: false, driveAddress: 0xff });

    expect([...message.subarray(8, 26)].every((byte) => byte === 0)).toBe(true);
    expect([...message.subarray(27, 53)].every((byte) => byte === 0)).toBe(true);
  });

  it('validates its inputs', () => {
    expect(() => buildSetConfig({ tgtAddr: 256 })).toThrow(RangeError);
    expect(() => buildSetConfig({ msgId: Uint8Array.from([1, 2, 3]) })).toThrow(RangeError);
    expect(() =>
      buildSetConfig({ truncated: false, worldWideNodeName: Uint8Array.from([1, 2]) }),
    ).toThrow(RangeError);
  });

  it('accepts a literal configuration flags byte, reserved bits included', () => {
    const message = buildSetConfig({ configurationFlagsByte: 0b0000_0101 });
    expect(message[SetConfigOffset.CONFIGURATION_FLAGS]).toBe(0b0000_0101);
  });

  it('produces a packet the length field agrees with', () => {
    for (const truncated of [true, false]) {
      const message = buildSetConfig({ truncated });
      const packet = encodePacket(message);
      expect((packet[1]! << 8) | packet[2]!).toBe(message.length);
    }
  });
});

describe('buildSetConfigResponse', () => {
  it('echoes the four Msg ID bytes of the Config_Request', () => {
    // The spec is emphatic: all four bytes must be identical to the request's,
    // even when the drive's LDI address is changing.
    const request = { msgId: Buffer.from([0x03, 0x11, 0x22, 0x33]) };
    const message = buildSetConfigResponse(request, { tgtAddr: 0x09 });

    expect([...message.subarray(2, 6)]).toEqual([0x03, 0x11, 0x22, 0x33]);
    // A new LDI address travels in Tgt Addr, not in the Msg ID.
    expect(message[1]).toBe(0x09);
  });
});

describe('parseSetConfig', () => {
  it('round-trips the truncated form', () => {
    const message = buildSetConfig({ tgtAddr: 0x02, driveAddress: 5 });
    const parsed = parseSetConfig(message);

    expect(parsed.kind).toBe('set-config');
    expect(parsed.tgtAddr).toBe(0x02);
    expect(parsed.driveAddress).toBe(5);
    expect(parsed.truncated).toBe(true);
    expect(parsed.libraryInformationField).toBeUndefined();
    expect(parsed.worldWideNodeName).toBeUndefined();
  });

  it('round-trips the full form', () => {
    const wwnn = Uint8Array.from([0x20, 0x00, 0x00, 0xe1, 0x11, 0x22, 0x33, 0x44]);
    const parsed = parseSetConfig(
      buildSetConfig({ truncated: false, libraryInformationField: 0x42, worldWideNodeName: wwnn }),
    );

    expect(parsed.truncated).toBe(false);
    expect(parsed.libraryInformationField).toBe(0x42);
    expect(parsed.worldWideNodeName?.equals(Buffer.from(wwnn))).toBe(true);
  });

  it('rejects a message of the wrong type or length', () => {
    const message = buildSetConfig();
    expect(() => parseSetConfig(message.subarray(0, 53))).toThrow(/shorter than/);

    const wrongType = Buffer.from(message);
    wrongType[0] = 0xab;
    expect(() => parseSetConfig(wrongType)).toThrow(/expected Msg Type 0xAC/);
  });
});
