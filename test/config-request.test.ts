import { describe, expect, it } from 'vitest';

import {
  buildConfigRequest,
  describeTargetAddress,
  formatConfigRequest,
  isConfigRequest,
  parseConfigRequest,
} from '../src/messages/config-request.js';
import { decodeMessage } from '../src/messages/decode.js';
import { MessageParseError } from '../src/messages/header.js';
import { buildSetConfigResponse, parseSetConfig } from '../src/messages/set-config.js';
import { decodePacket, encodePacket } from '../src/packet.js';

/**
 * A Config_Request as a drive at LDI address 3 sends it: Msg Type 0xAB,
 * Tgt Addr 0xFF (the library), a Msg ID whose first byte is the originating
 * drive's address, and Msg Subtype 0x01.
 */
const CONFIG_REQUEST = Buffer.from([0xab, 0xff, 0x03, 0x00, 0x00, 0x2a, 0x01]);

describe('parseConfigRequest', () => {
  it('decodes the seven message bytes', () => {
    const request = parseConfigRequest(CONFIG_REQUEST);

    expect(request.kind).toBe('config-request');
    expect(request.msgType).toBe(0xab);
    expect(request.tgtAddr).toBe(0xff);
    expect([...request.msgId]).toEqual([0x03, 0x00, 0x00, 0x2a]);
    expect(request.msgSubtype).toBe(0x01);
  });

  it('is recognised by isConfigRequest', () => {
    expect(isConfigRequest(CONFIG_REQUEST)).toBe(true);
    expect(isConfigRequest(Buffer.from([0xab, 0xff, 0, 0, 0, 1, 0x40]))).toBe(false);
    expect(isConfigRequest(Buffer.from([0xac, 0xff, 0, 0, 0, 1, 0x01]))).toBe(false);
  });

  it('rejects a message of the wrong type or subtype', () => {
    expect(() => parseConfigRequest(Buffer.from([0xac, 0xff, 0, 0, 0, 1, 0x01]))).toThrow(
      /expected Msg Type 0xAB/,
    );
    expect(() => parseConfigRequest(Buffer.from([0xab, 0xff, 0, 0, 0, 1, 0x40]))).toThrow(
      /expected Msg Subtype 0x01/,
    );
  });

  it('rejects a message too short to hold a header', () => {
    expect(() => parseConfigRequest(Buffer.from([0xab, 0xff, 0x00]))).toThrow(MessageParseError);
  });

  it('rejects a Two_Way message with no subtype byte', () => {
    expect(() => parseConfigRequest(Buffer.from([0xab, 0xff, 0, 0, 0, 1]))).toThrow(/no subtype/);
  });

  it('arrives intact through the packet layer', () => {
    const packet = encodePacket(buildConfigRequest(Uint8Array.from([0x01, 0x00, 0x00, 0x07])));
    const decoded = decodePacket(packet);

    expect(decoded.kind).toBe('packet');
    const message = decodeMessage((decoded as { message: Buffer }).message);
    expect(message.kind).toBe('config-request');
  });

  it('is dispatched to the right parser by decodeMessage', () => {
    expect(decodeMessage(CONFIG_REQUEST).kind).toBe('config-request');
  });
});

describe('formatConfigRequest', () => {
  it('reports every field and explains what to do next', () => {
    const report = formatConfigRequest(parseConfigRequest(CONFIG_REQUEST));

    expect(report).toContain('Config_Request (Drive-to-Library, Type=0xAB, Subtype=0x01)');
    expect(report).toContain('AB FF 03 00 00 2A 01'); // raw bytes
    expect(report).toContain('0xFF (library)'); // target address
    expect(report).toContain('03 00 00 2A'); // Msg ID
    expect(report).toContain('0x03 (drive 3)'); // originator, from Msg ID byte 0
    expect(report).toContain('Set_Config');
  });

  it('describes each class of LDI address', () => {
    expect(describeTargetAddress(0xff)).toBe('(library)');
    expect(describeTargetAddress(0x00)).toBe('(unassigned)');
    expect(describeTargetAddress(0x01)).toBe('(drive 1)');
    expect(describeTargetAddress(0xfe)).toBe('(drive 254)');
  });
});

describe('answering a Config_Request', () => {
  it('produces a Set_Config carrying the request Msg ID unchanged', () => {
    const request = parseConfigRequest(CONFIG_REQUEST);
    const response = buildSetConfigResponse(request, { tgtAddr: 0x03 });
    const parsed = parseSetConfig(response);

    expect(parsed.msgId.equals(request.msgId)).toBe(true);
    expect(parsed.tgtAddr).toBe(0x03);
    expect(parsed.configurationFlags.disableAutomaticDriveOnline).toBe(false);
  });
});
