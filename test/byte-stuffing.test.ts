import { describe, expect, it } from 'vitest';

import { ByteStuffingError, stuff, unstuff } from '../src/byte-stuffing.js';

describe('byte stuffing', () => {
  it('escapes the three special byte values', () => {
    expect([...stuff(Uint8Array.from([0x02]))]).toEqual([0xff, 0xf2]);
    expect([...stuff(Uint8Array.from([0x03]))]).toEqual([0xff, 0xf3]);
    expect([...stuff(Uint8Array.from([0xff]))]).toEqual([0xff, 0xff]);
  });

  it('leaves every other byte alone', () => {
    const plain = Uint8Array.from([0x00, 0x01, 0x04, 0x7f, 0x80, 0xf2, 0xf3, 0xfe]);
    expect([...stuff(plain)]).toEqual([...plain]);
  });

  it('reproduces the worked example from spec Figure 3', () => {
    // The spec shows the packet 02 | 00 02 | 23 FF | 24 | 03 being transmitted
    // as 02 | 00 FF F2 | 23 FF FF | 24 | 03.
    const lengthAndMessage = Uint8Array.from([0x00, 0x02, 0x23, 0xff]);
    expect([...stuff(lengthAndMessage)]).toEqual([0x00, 0xff, 0xf2, 0x23, 0xff, 0xff]);
  });

  it('guarantees no STX or ETX survives in stuffed output', () => {
    const everyByte = Uint8Array.from({ length: 256 }, (_, index) => index);
    const stuffed = stuff(everyByte);
    expect(stuffed.includes(0x02)).toBe(false);
    expect(stuffed.includes(0x03)).toBe(false);
  });

  it('round-trips every byte value', () => {
    const everyByte = Uint8Array.from({ length: 256 }, (_, index) => index);
    expect(unstuff(stuff(everyByte)).equals(Buffer.from(everyByte))).toBe(true);
  });

  it('round-trips random data', () => {
    for (let trial = 0; trial < 200; trial++) {
      const data = Uint8Array.from({ length: 1 + (trial % 64) }, () =>
        Math.floor(Math.random() * 256),
      );
      expect(unstuff(stuff(data)).equals(Buffer.from(data))).toBe(true);
    }
  });

  it('rejects an undefined escape sequence', () => {
    // 0xFF followed by anything other than 0xF2, 0xF3 or 0xFF is undefined and
    // the spec says the receiver should NAK.
    expect(() => unstuff(Uint8Array.from([0xff, 0x01]))).toThrow(ByteStuffingError);
    expect(() => unstuff(Uint8Array.from([0x10, 0xff, 0xf1]))).toThrow(/undefined escape sequence/);
  });

  it('rejects a dangling escape byte', () => {
    expect(() => unstuff(Uint8Array.from([0x10, 0xff]))).toThrow(/dangling escape byte/);
  });
});
