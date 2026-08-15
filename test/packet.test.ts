import { describe, expect, it } from 'vitest';

import { computeBcc, computeBccFromParts, encodeLengthBytes } from '../src/bcc.js';
import { ControlCharacter } from '../src/constants.js';
import {
  ACK_RESPONSE,
  decodePacket,
  encodePacket,
  NAK_RESPONSE,
  PacketDecoder,
  SNAK_RESPONSE,
} from '../src/packet.js';

describe('BCC', () => {
  it('matches the worked example from spec Figure 3', () => {
    // Packet 02 | 00 02 | 23 FF | 24 | 03: the BCC over L1, L2 and the two
    // message bytes is 0x00 + 0x02 + 0x23 + 0xFF = 0x124, low byte 0x24.
    expect(computeBccFromParts(0x00, 0x02, Uint8Array.from([0x23, 0xff]))).toBe(0x24);
    expect(computeBcc(Uint8Array.from([0x23, 0xff]))).toBe(0x24);
  });

  it('sums the length bytes as well as the message', () => {
    // Without the length bytes the sum would be 0, not 0x0A.
    const message = new Uint8Array(10);
    expect(computeBcc(message)).toBe(0x0a);
  });

  it('wraps modulo 256', () => {
    expect(computeBcc(Uint8Array.from([0xff, 0xff]))).toBe((2 + 0xff + 0xff) & 0xff);
  });

  it('encodes the length high-order byte first', () => {
    expect(encodeLengthBytes(0x0036)).toEqual([0x00, 0x36]);
    expect(encodeLengthBytes(507)).toEqual([0x01, 0xfb]);
    expect(() => encodeLengthBytes(0x10000)).toThrow(RangeError);
  });
});

describe('encodePacket', () => {
  it('frames a message with STX, length, BCC and ETX', () => {
    const message = Uint8Array.from([0xab, 0xff, 0x00, 0x00, 0x00, 0x01, 0x01]);
    const packet = encodePacket(message);

    expect(packet[0]).toBe(ControlCharacter.STX);
    expect(packet.at(-1)).toBe(ControlCharacter.ETX);
    expect([packet[1], packet[2]]).toEqual([0x00, 0x07]);
    expect(packet.at(-2)).toBe(computeBcc(message));
  });

  it('stuffs the message so no stray STX or ETX appears', () => {
    // A message full of bytes that need escaping.
    const message = Uint8Array.from([0xab, 0x02, 0x03, 0xff, 0x02, 0x03]);
    const packet = encodePacket(message);

    const interior = packet.subarray(1, packet.length - 1);
    expect(interior.includes(ControlCharacter.STX)).toBe(false);
    expect(interior.includes(ControlCharacter.ETX)).toBe(false);
  });

  it('stuffs a BCC that would otherwise collide with ETX', () => {
    // Find a message whose BCC lands on 0x03; unstuffed it would end the packet
    // early, so it has to be escaped.
    let message: Uint8Array | undefined;
    for (let value = 0; value < 256; value++) {
      const candidate = Uint8Array.from([0xab, 0xff, 0x00, 0x00, 0x00, value]);
      if (computeBcc(candidate) === ControlCharacter.ETX) {
        message = candidate;
        break;
      }
    }
    expect(message).toBeDefined();

    const packet = encodePacket(message!);
    // Exactly one ETX, at the very end.
    expect([...packet].filter((byte) => byte === ControlCharacter.ETX)).toHaveLength(1);
    expect(packet.at(-1)).toBe(ControlCharacter.ETX);
    // The BCC arrives escaped.
    expect([...packet.subarray(-3, -1)]).toEqual([0xff, 0xf3]);

    const decoded = decodePacket(packet);
    expect(decoded.kind).toBe('packet');
  });

  it('rejects messages outside the 6..507 byte range', () => {
    expect(() => encodePacket(new Uint8Array(5))).toThrow(RangeError);
    expect(() => encodePacket(new Uint8Array(508))).toThrow(RangeError);
    expect(() => encodePacket(new Uint8Array(6))).not.toThrow();
    expect(() => encodePacket(new Uint8Array(507))).not.toThrow();
  });

  it('round-trips every message length in range', () => {
    for (const length of [6, 7, 54, 64, 255, 256, 506, 507]) {
      const message = Uint8Array.from({ length }, (_, index) => (index * 7 + 3) & 0xff);
      const decoded = decodePacket(encodePacket(message));
      expect(decoded.kind).toBe('packet');
      expect((decoded as { message: Buffer }).message.equals(Buffer.from(message))).toBe(true);
    }
  });
});

describe('decodePacket', () => {
  it('reports a checksum error', () => {
    const packet = Buffer.from(encodePacket(new Uint8Array(6)));
    packet[packet.length - 2] = (packet[packet.length - 2]! + 1) & 0xff;

    const result = decodePacket(packet);
    expect(result.kind).toBe('error');
    expect((result as { reason: string }).reason).toBe('checksum');
  });

  it('reports a length error', () => {
    const packet = Buffer.from(encodePacket(new Uint8Array(6)));
    packet[2] = 0x09; // claim nine message bytes when six are present

    const result = decodePacket(packet);
    expect(result.kind).toBe('error');
    expect((result as { reason: string }).reason).toBe('length');
  });

  it('reports a byte-stuffing error', () => {
    const packet = Buffer.from([
      ControlCharacter.STX,
      0x00,
      0x06,
      0xff,
      0x01, // undefined escape sequence
      0x00,
      0x00,
      0x00,
      0x00,
      0x06,
      ControlCharacter.ETX,
    ]);

    const result = decodePacket(packet);
    expect(result.kind).toBe('error');
    expect((result as { reason: string }).reason).toBe('stuffing');
  });

  it('reports a truncated packet', () => {
    const result = decodePacket(Buffer.from([ControlCharacter.STX, 0x00, ControlCharacter.ETX]));
    expect(result.kind).toBe('error');
    expect((result as { reason: string }).reason).toBe('truncated');
  });

  it('refuses buffers that are not framed by STX and ETX', () => {
    expect(() => decodePacket(Buffer.from([0x00, 0x01, ControlCharacter.ETX]))).toThrow(/STX/);
    expect(() => decodePacket(Buffer.from([ControlCharacter.STX, 0x01, 0x02]))).toThrow(/ETX/);
  });
});

describe('PacketDecoder', () => {
  const message = Uint8Array.from([0xab, 0xff, 0x00, 0x00, 0x00, 0x01, 0x01]);

  it('decodes a packet delivered in one chunk', () => {
    const decoder = new PacketDecoder();
    const events = decoder.push(encodePacket(message));

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('packet');
  });

  it('decodes a packet delivered one byte at a time', () => {
    const decoder = new PacketDecoder();
    const packet = encodePacket(message);
    const events = [...packet].flatMap((byte) => decoder.push(Uint8Array.from([byte])));

    expect(events.filter((event) => event.kind === 'packet')).toHaveLength(1);
  });

  it('decodes back-to-back packets', () => {
    const decoder = new PacketDecoder();
    const events = decoder.push(Buffer.concat([encodePacket(message), encodePacket(message)]));

    expect(events.filter((event) => event.kind === 'packet')).toHaveLength(2);
  });

  it('recognises ACK, NAK and SNAK, each followed by its ETX', () => {
    const decoder = new PacketDecoder();
    const events = decoder.push(Buffer.concat([ACK_RESPONSE, NAK_RESPONSE, SNAK_RESPONSE]));

    expect(events.map((event) => event.kind)).toEqual(['ack', 'nak', 'snak']);
  });

  it('ignores bytes ahead of an STX and reports them as discarded', () => {
    // The drive emits a self-test sequence ending in ETX before power-on reset
    // completes; the spec requires a receiver to discard it.
    const decoder = new PacketDecoder();
    const noise = Buffer.from([0x55, 0xaa, 0x7f, ControlCharacter.ETX]);
    const events = decoder.push(Buffer.concat([noise, encodePacket(message)]));

    const discarded = events.filter((event) => event.kind === 'discarded');
    expect(discarded).toHaveLength(1);
    expect(events.filter((event) => event.kind === 'packet')).toHaveLength(1);
  });

  it('drops a partial packet when a fresh STX arrives', () => {
    const decoder = new PacketDecoder();
    decoder.push(Buffer.from([ControlCharacter.STX, 0x00, 0x07, 0xab]));
    const events = decoder.push(encodePacket(message));

    expect(events.filter((event) => event.kind === 'packet')).toHaveLength(1);
    expect(events.filter((event) => event.kind === 'discarded')).toHaveLength(1);
  });

  it('surfaces an invalid packet as an error event rather than throwing', () => {
    const decoder = new PacketDecoder();
    const packet = Buffer.from(encodePacket(message));
    packet[packet.length - 2] = (packet[packet.length - 2]! + 1) & 0xff;

    const events = decoder.push(packet);
    expect(events[0]!.kind).toBe('error');
  });

  it('does not mistake message data for a control character', () => {
    // A message whose bytes include ACK, NAK and SNAK values must still decode
    // as a single packet.
    const trickyMessage = Uint8Array.from([0xab, 0xff, ControlCharacter.ACK, ControlCharacter.NAK, ControlCharacter.SNAK, 0x01]);
    const decoder = new PacketDecoder();
    const events = decoder.push(encodePacket(trickyMessage));

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('packet');
    expect((events[0] as { message: Buffer }).message.equals(Buffer.from(trickyMessage))).toBe(true);
  });
});
