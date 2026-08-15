/**
 * Session-level tests: acknowledgements, retries, the Drive Type primitive and
 * the full Config_Request -> Set_Config -> Drive_Status handshake, all driven
 * against an in-memory stand-in for the serial port.
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { ACK_RESPONSE, encodePacket, NAK_RESPONSE, SNAK_RESPONSE } from '../src/packet.js';
import { buildConfigRequest } from '../src/messages/config-request.js';
import { buildSetConfigResponse, parseSetConfig } from '../src/messages/set-config.js';
import { LdiSendError, LdiSession, LdiTimeoutError, type LdiStream } from '../src/session.js';
import { REFERENCE_SET_CONFIG_PACKET } from '../src/reference.js';

/** A loopback stand-in for a serial port. */
class FakeStream extends EventEmitter implements LdiStream {
  /** Everything the session has written, in order. */
  readonly written: Buffer[] = [];

  write(chunk: Uint8Array, callback?: (error?: Error | null) => void): boolean {
    this.written.push(Buffer.from(chunk));
    callback?.(null);
    return true;
  }

  /** Feeds bytes to the session as if the drive had sent them. */
  receive(chunk: Uint8Array): void {
    this.emit('data', Buffer.from(chunk));
  }

  /** The concatenation of everything written. */
  get all(): Buffer {
    return Buffer.concat(this.written);
  }
}

/**
 * Waits until the session has written `count` chunks.
 *
 * A retry passes through several microtask hops - resolve the response, unwind
 * `waitForResponse`, re-enter the send loop, await the next write - so tests
 * wait on the observable effect rather than guessing how many ticks that takes.
 */
async function untilWritten(stream: FakeStream, count: number): Promise<void> {
  for (let tick = 0; tick < 100 && stream.written.length < count; tick++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(stream.written.length).toBeGreaterThanOrEqual(count);
}

/** A 32-byte Drive_Status reporting an idle, online SCSI drive. */
function driveStatusMessage(msgId: Uint8Array): Buffer {
  const message = Buffer.alloc(32);
  message[0] = 0xab;
  message[1] = 0xff;
  Buffer.from(msgId).copy(message, 2);
  message[6] = 0x40;
  message[7] = 0x80; // no cartridge loaded
  message[8] = 0x17;
  return message;
}

describe('LdiSession acknowledgements', () => {
  it('ACKs a valid packet it receives', () => {
    const stream = new FakeStream();
    const session = new LdiSession(stream);

    stream.receive(encodePacket(buildConfigRequest(Uint8Array.from([1, 0, 0, 1]))));

    expect(stream.all.equals(ACK_RESPONSE)).toBe(true);
    session.close();
  });

  it('NAKs a packet with a bad checksum', () => {
    const stream = new FakeStream();
    const session = new LdiSession(stream);
    const errors: string[] = [];
    session.on('packet-error', (error) => errors.push(error.reason));

    const packet = Buffer.from(encodePacket(buildConfigRequest(Uint8Array.from([1, 0, 0, 1]))));
    packet[packet.length - 2] = (packet[packet.length - 2]! + 1) & 0xff;
    stream.receive(packet);

    expect(stream.all.equals(NAK_RESPONSE)).toBe(true);
    expect(errors).toEqual(['checksum']);
    session.close();
  });

  it('stays silent when auto-acknowledgement is off', () => {
    const stream = new FakeStream();
    const session = new LdiSession(stream, { autoAcknowledge: false });

    stream.receive(encodePacket(buildConfigRequest(Uint8Array.from([1, 0, 0, 1]))));

    expect(stream.written).toHaveLength(0);
    session.close();
  });

  it('reports non-packet bytes as discarded rather than acknowledging them', () => {
    const stream = new FakeStream();
    const session = new LdiSession(stream);
    const discarded: Buffer[] = [];
    session.on('discarded', (bytes) => discarded.push(bytes));

    // The self-test sequence a drive emits before power-on reset completes.
    stream.receive(Buffer.from([0x55, 0xaa, 0x03]));

    expect(discarded).toHaveLength(1);
    expect(stream.written).toHaveLength(0);
    session.close();
  });
});

describe('LdiSession.sendPacket', () => {
  it('resolves once the drive ACKs', async () => {
    const stream = new FakeStream();
    const session = new LdiSession(stream);

    const sent = session.sendPacket(REFERENCE_SET_CONFIG_PACKET);
    await Promise.resolve();
    stream.receive(ACK_RESPONSE);

    await expect(sent).resolves.toBeUndefined();
    expect(stream.written[0]!.equals(REFERENCE_SET_CONFIG_PACKET)).toBe(true);
    session.close();
  });

  it('retries after a NAK and succeeds on the next ACK', async () => {
    const stream = new FakeStream();
    const session = new LdiSession(stream);

    const sent = session.sendPacket(REFERENCE_SET_CONFIG_PACKET);
    await untilWritten(stream, 1);
    stream.receive(NAK_RESPONSE);
    await untilWritten(stream, 2);
    stream.receive(ACK_RESPONSE);

    await expect(sent).resolves.toBeUndefined();
    expect(stream.written).toHaveLength(2);
    // The retry is the same packet, byte for byte.
    expect(stream.written[1]!.equals(stream.written[0]!)).toBe(true);
    session.close();
  });

  it('gives up after the configured number of NAKs', async () => {
    const stream = new FakeStream();
    const session = new LdiSession(stream, { retries: 2 });

    const sent = session.sendPacket(REFERENCE_SET_CONFIG_PACKET);
    const failure = expect(sent).rejects.toThrow(LdiSendError);

    // Three attempts in total: the original send plus two retries.
    for (let attempt = 1; attempt <= 3; attempt++) {
      await untilWritten(stream, attempt);
      stream.receive(NAK_RESPONSE);
    }

    await failure;
    expect(stream.written).toHaveLength(3);
    session.close();
  });

  it('waits before retrying after a SNAK', async () => {
    vi.useFakeTimers();
    try {
      const stream = new FakeStream();
      const session = new LdiSession(stream, { snakRetryDelayMs: 10_000 });

      const sent = session.sendPacket(REFERENCE_SET_CONFIG_PACKET);
      await Promise.resolve();
      stream.receive(SNAK_RESPONSE);
      await Promise.resolve();

      // Still only the first attempt: the session is serving out the delay.
      expect(stream.written).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(stream.written).toHaveLength(2);

      stream.receive(ACK_RESPONSE);
      await expect(sent).resolves.toBeUndefined();
      session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries and then fails when nothing answers', async () => {
    vi.useFakeTimers();
    try {
      const stream = new FakeStream();
      const session = new LdiSession(stream, { sendTimeoutMs: 5_000, retries: 3 });

      const sent = session.sendPacket(REFERENCE_SET_CONFIG_PACKET);
      const failure = expect(sent).rejects.toThrow(/no ACK, NAK or SNAK after 4 attempts/);

      await vi.advanceTimersByTimeAsync(5_000 * 4 + 10);
      await failure;

      expect(stream.written).toHaveLength(4);
      session.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('LdiSession.requestDriveType', () => {
  it('sends 0x00 and verifies the drive answers IBM', async () => {
    const stream = new FakeStream();
    const session = new LdiSession(stream);

    const pending = session.requestDriveType(1_000);
    await Promise.resolve();

    // The request is a bare 0x00 with no packet framing at all.
    expect(stream.all.equals(Buffer.from([0x00]))).toBe(true);

    stream.receive(Buffer.from([0xfa, 0x49, 0x42, 0x4d, 0x80, 0x4b, 0x39, 0x41, 0x30]));

    const driveType = await pending;
    expect(driveType.vendor).toBe('IBM');
    expect(driveType.isIbmDrive).toBe(true);
    expect(driveType.firmwareRevisionAscii).toBe('K9A0');
    session.close();
  });

  it('reassembles a response split across chunks', async () => {
    const stream = new FakeStream();
    const session = new LdiSession(stream);

    const pending = session.requestDriveType(1_000);
    await Promise.resolve();

    stream.receive(Buffer.from([0xfa, 0x49]));
    stream.receive(Buffer.from([0x42, 0x4d, 0x80]));
    stream.receive(Buffer.from([0x4b, 0x39, 0x41, 0x30]));

    await expect(pending).resolves.toMatchObject({ isIbmDrive: true });
    session.close();
  });

  it('does not treat the raw response as packet traffic', async () => {
    const stream = new FakeStream();
    const session = new LdiSession(stream);
    const discarded: Buffer[] = [];
    session.on('discarded', (bytes) => discarded.push(bytes));

    const pending = session.requestDriveType(1_000);
    await Promise.resolve();
    stream.receive(Buffer.from([0xfa, 0x49, 0x42, 0x4d, 0x80, 0x00, 0x00, 0x00, 0x00]));
    await pending;

    // Nothing was written except the request, and no ACK was emitted for it.
    expect(stream.all.equals(Buffer.from([0x00]))).toBe(true);
    expect(discarded).toHaveLength(0);
    session.close();
  });

  it('times out when the drive stays quiet', async () => {
    vi.useFakeTimers();
    try {
      const stream = new FakeStream();
      const session = new LdiSession(stream);

      const pending = session.requestDriveType(3_000);
      const failure = expect(pending).rejects.toThrow(LdiTimeoutError);
      await vi.advanceTimersByTimeAsync(3_000);
      await failure;
      session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports how many bytes did arrive when it times out', async () => {
    vi.useFakeTimers();
    try {
      const stream = new FakeStream();
      const session = new LdiSession(stream);

      const pending = session.requestDriveType(3_000);
      const failure = expect(pending).rejects.toThrow(/received 2 of 9 bytes: FA 49/);
      await Promise.resolve();
      stream.receive(Buffer.from([0xfa, 0x49]));
      await vi.advanceTimersByTimeAsync(3_000);
      await failure;
      session.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('drive-initiated handshake', () => {
  it('answers a Config_Request with a Set_Config that carries the same Msg ID', async () => {
    const stream = new FakeStream();
    const session = new LdiSession(stream);
    const msgId = Uint8Array.from([0x02, 0xab, 0xcd, 0xef]);

    // The drive powers up in non-polled mode and asks for its configuration.
    const pending = session.waitForConfigRequest(1_000);
    stream.receive(encodePacket(buildConfigRequest(msgId)));
    const request = await pending;

    expect([...request.msgId]).toEqual([...msgId]);
    // The session ACKed the Config_Request as a receiver must.
    expect(stream.all.equals(ACK_RESPONSE)).toBe(true);

    // The library answers with a Set_Config echoing those four bytes.
    const sent = session.sendMessage(buildSetConfigResponse(request, { tgtAddr: 0x02 }));
    await Promise.resolve();
    stream.receive(ACK_RESPONSE);
    await sent;

    const setConfigPacket = stream.written[1]!;
    const message = parseSetConfig(
      // Strip STX/L1/L2 and BCC/ETX; nothing in this message needs unstuffing
      // except byte 6, so decode it properly instead of slicing.
      (
        (await import('../src/packet.js')).decodePacket(setConfigPacket) as { message: Buffer }
      ).message,
    );

    expect(message.msgId.equals(request.msgId)).toBe(true);
    expect(message.tgtAddr).toBe(0x02);
    expect(message.configurationFlags.disableAutomaticDriveOnline).toBe(false);
    session.close();
  });

  it('surfaces the Drive_Status the drive sends after accepting a Set_Config', async () => {
    const stream = new FakeStream();
    const session = new LdiSession(stream);
    const msgId = Uint8Array.from([0x01, 0x00, 0x00, 0x05]);

    const pending = session.waitForDriveStatus(1_000);
    stream.receive(encodePacket(driveStatusMessage(msgId)));

    const status = await pending;
    expect(status.kind).toBe('drive-status');
    expect(status.flags1.cartridgeNotLoaded).toBe(true);
    session.close();
  });

  it('times out when no Config_Request arrives', async () => {
    vi.useFakeTimers();
    try {
      const stream = new FakeStream();
      const session = new LdiSession(stream);

      const pending = session.waitForConfigRequest(10_000);
      const failure = expect(pending).rejects.toThrow(/no Config_Request received within 10000 ms/);
      await vi.advanceTimersByTimeAsync(10_000);
      await failure;
      session.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
