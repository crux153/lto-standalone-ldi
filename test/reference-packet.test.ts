/**
 * The headline regression test: the packet this library builds must be byte for
 * byte the packet that is documented to work on real hardware.
 *
 * Sources for the expected bytes:
 *  - https://github.com/AC7RNsphnHVbyT4/ibm-tape-drive-automatic-standalone
 *  - https://piro400.hatenablog.com/entry/2024/08/26/213949
 *
 * Both publish the same 60-byte sequence and both report that the drive
 * answered ACK (0x06) + ETX (0x03) and then rebooted into standalone mode.
 */

import { describe, expect, it } from 'vitest';

import {
  buildSetConfig,
  decodeMessage,
  decodePacket,
  encodePacket,
  parseEscapedHex,
  parseSetConfig,
  REFERENCE_SET_CONFIG_ESCAPED,
  REFERENCE_SET_CONFIG_PACKET,
  SET_CONFIG_TRUNCATED_LENGTH,
} from '../src/index.js';

/**
 * The packet exactly as the GitHub README publishes it, written here as the
 * `\xNN` string from that page so the expectation is transcribed rather than
 * re-derived from anything this library produces.
 */
const README_ESCAPED =
  '\\x02\\x00\\x36\\xAC\\x01\\x00\\x00\\x00\\x01\\xFF\\xF2\\x00\\x00\\x00\\x00\\x00\\x00\\x00' +
  '\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00' +
  '\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00' +
  '\\x00\\x00\\x00\\x00\\xE6\\x03';

/**
 * The same packet as the Japanese blog publishes it: space-separated hex.
 * Transcribed independently from the escaped form above.
 */
const BLOG_HEX =
  '02 00 36 AC 01 00 00 00 01 FF F2 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 E6 03';

describe('published reference packet', () => {
  it('is transcribed identically by both sources', () => {
    const fromReadme = parseEscapedHex(README_ESCAPED);
    const fromBlog = Buffer.from(BLOG_HEX.replace(/\s/g, ''), 'hex');

    expect(fromReadme.length).toBe(60);
    expect(fromBlog.equals(fromReadme)).toBe(true);
  });

  it('matches the constant this library ships', () => {
    expect(REFERENCE_SET_CONFIG_PACKET.equals(parseEscapedHex(README_ESCAPED))).toBe(true);
    expect(REFERENCE_SET_CONFIG_ESCAPED).toBe(README_ESCAPED);
  });

  it('is produced by buildSetConfig + encodePacket with the default options', () => {
    // Defaults: 54-byte firmware-independent form, drive LDI address 1,
    // Msg ID 00 00 00 01, FC/SCSI address 0, every configuration flag clear.
    const message = buildSetConfig();
    const packet = encodePacket(message);

    expect(message.length).toBe(SET_CONFIG_TRUNCATED_LENGTH);
    expect(packet.toString('hex')).toBe(parseEscapedHex(README_ESCAPED).toString('hex'));
  });

  it('decodes back into a spec-conforming Set_Config', () => {
    const decoded = decodePacket(REFERENCE_SET_CONFIG_PACKET);
    expect(decoded.kind).toBe('packet');

    const message = (decoded as { kind: 'packet'; message: Buffer }).message;
    // 54 unstuffed bytes, matching the L1/L2 field of 0x0036.
    expect(message.length).toBe(54);

    const config = parseSetConfig(message);
    expect(config.msgType).toBe(0xac);
    expect(config.tgtAddr).toBe(0x01);
    expect([...config.msgId]).toEqual([0x00, 0x00, 0x00, 0x01]);
    // Byte 6 is 0x02, which is precisely why the packet contains FF F2.
    expect(config.interfaceVersionMajor).toBe(0x02);
    expect(config.interfaceVersionMinor).toBe(0x00);
    expect(config.driveAddress).toBe(0);
    expect(config.truncated).toBe(true);

    // The whole point: bit 3 clear means the drive goes online by itself.
    expect(config.configurationFlags.value).toBe(0x00);
    expect(config.configurationFlags.disableAutomaticDriveOnline).toBe(false);
  });

  it('carries the FF F2 pair as byte stuffing, not as message data', () => {
    // On the wire the sequence appears at offset 9..10.
    expect([...REFERENCE_SET_CONFIG_PACKET.subarray(9, 11)]).toEqual([0xff, 0xf2]);

    const message = (decodePacket(REFERENCE_SET_CONFIG_PACKET) as { message: Buffer }).message;
    // After unstuffing it is a single 0x02 at message byte 6.
    expect(message[6]).toBe(0x02);
    // ...and no 0xFF survives anywhere in the message.
    expect(message.includes(0xff)).toBe(false);
  });

  it('has a BCC of 0xE6, computed over the unstuffed bytes', () => {
    expect(REFERENCE_SET_CONFIG_PACKET.at(-2)).toBe(0xe6);

    // 0x00 + 0x36 (length) + 0xAC + 0x01 + 0x01 + 0x02 (the non-zero message
    // bytes) = 0x1E6, whose low byte is 0xE6.
    const sum = 0x00 + 0x36 + 0xac + 0x01 + 0x01 + 0x02;
    expect(sum & 0xff).toBe(0xe6);

    // Summing the *stuffed* bytes instead gives 0x9F+0x36 = 0xD5, which is the
    // mismatch the Japanese write-up reports.
    const stuffedSum =
      [...REFERENCE_SET_CONFIG_PACKET.subarray(3, 58)].reduce((a, b) => a + b, 0) + 0x00 + 0x36;
    expect(stuffedSum & 0xff).not.toBe(0xe6);
  });

  it('round-trips through decodeMessage', () => {
    const message = (decodePacket(REFERENCE_SET_CONFIG_PACKET) as { message: Buffer }).message;
    const decoded = decodeMessage(message);
    expect(decoded.kind).toBe('set-config');
  });
});
