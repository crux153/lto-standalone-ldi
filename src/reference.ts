/**
 * The field-proven Set_Config packet, kept here as a regression anchor.
 *
 * This exact 60-byte sequence is the one published in
 * https://github.com/AC7RNsphnHVbyT4/ibm-tape-drive-automatic-standalone and
 * independently replayed in https://piro400.hatenablog.com/entry/2024/08/26/213949,
 * where it made an IBM LTO-6 drive answer ACK+ETX, reboot, and come up on its
 * SCSI/Fibre Channel port without a library attached.
 *
 * On the wire:
 *
 * ```
 * 02          STX
 * 00 36       L1 L2         54 message bytes
 * AC          Msg Type      Set_Config
 * 01          Tgt Addr      drive LDI address 1
 * 00 00 00 01 Msg ID
 * FF F2       byte 6        Interface Version Major, 0x02 stuffed as FF F2
 * 00          byte 7        Interface Version Minor
 * 00 x18      bytes 8-25    reserved
 * 00          byte 26       Drive FC/SCSI Address
 * 00 x26      bytes 27-52   reserved
 * 00          byte 53       Configuration Flags, bit 3 clear: automatic drive online
 * E6          BCC           (0x00 + 0x36 + 0xAC + 0x01 + 0x01 + 0x02) & 0xFF
 * 03          ETX
 * ```
 *
 * Note the `FF F2` in the middle: it is not a message field but byte stuffing
 * for the 0x02 in byte 6. Checksumming the stuffed bytes instead of the
 * unstuffed ones is what makes the BCC look wrong, and is why the Japanese
 * write-up reports a mismatch it could not account for.
 */

/** The reference packet exactly as transmitted, STX through ETX. */
export const REFERENCE_SET_CONFIG_PACKET: Buffer = Buffer.from([
  0x02, 0x00, 0x36, 0xac, 0x01, 0x00, 0x00, 0x00, 0x01, 0xff, 0xf2, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xe6, 0x03,
]);

/**
 * The reference packet written the way both write-ups publish it: an escaped
 * string suitable for `echo -en`.
 */
export const REFERENCE_SET_CONFIG_ESCAPED: string =
  '\\x02\\x00\\x36\\xAC\\x01\\x00\\x00\\x00\\x01\\xFF\\xF2' + '\\x00'.repeat(47) + '\\xE6\\x03';

/**
 * Parses an escaped `\xNN` string of the kind the two write-ups publish.
 *
 * Provided so a captured packet can be pasted in and checked against what this
 * library builds.
 */
export function parseEscapedHex(input: string): Buffer {
  const matches = input.trim().match(/\\x[0-9a-fA-F]{2}/g);
  if (!matches || matches.join('').length !== input.trim().length) {
    throw new SyntaxError('input is not a sequence of \\xNN escapes');
  }
  return Buffer.from(matches.map((escape) => Number.parseInt(escape.slice(2), 16)));
}
