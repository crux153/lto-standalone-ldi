/**
 * An LDI session: packet framing, acknowledgements, retries and the
 * Config_Request/Set_Config handshake, driven over any duplex byte stream.
 *
 * The session plays the role of the *library* side of the interface. It is
 * written against a minimal stream interface rather than against `serialport`
 * directly, so it can be exercised against an in-memory fake in tests.
 */

import { EventEmitter } from 'node:events';

import { Timing } from './constants.js';
import {
  ACK_RESPONSE,
  encodePacket,
  NAK_RESPONSE,
  PacketDecoder,
  type DecodedEvent,
  type PacketErrorEvent,
} from './packet.js';
import {
  decodeMessage,
  DRIVE_TYPE_REQUEST,
  parseDriveType,
  type ConfigRequest,
  type DriveStatus,
  type DriveType,
  type LdiMessage,
} from './messages/index.js';
import { DRIVE_TYPE_RESPONSE_LENGTH } from './constants.js';

/** The subset of a duplex stream the session needs. */
export interface LdiStream {
  write(chunk: Uint8Array, callback?: (error?: Error | null) => void): boolean;
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  off(event: 'data', listener: (chunk: Buffer) => void): unknown;
  off(event: 'error', listener: (error: Error) => void): unknown;
  /** Optional; awaited after each write when the stream provides it. */
  drain?(callback: (error?: Error | null) => void): void;
}

/** Options for {@link LdiSession}. */
export interface LdiSessionOptions {
  /**
   * Acknowledge every valid packet with ACK+ETX and every invalid one with
   * NAK+ETX, as the spec requires of a receiver.
   *
   * @default true
   */
  autoAcknowledge?: boolean;
  /** Time to wait for an ACK/NAK/SNAK after a packet is sent. */
  sendTimeoutMs?: number;
  /** Resends attempted after a timeout or a NAK. */
  retries?: number;
  /** Resends attempted after a SNAK. */
  snakRetries?: number;
  /** Delay before resending after a SNAK. */
  snakRetryDelayMs?: number;
}

/** Events emitted by {@link LdiSession}. */
export interface LdiSessionEvents {
  /** A valid packet arrived and its message was decoded. */
  message: [message: LdiMessage, raw: Buffer];
  /** Convenience event for a decoded Config_Request. */
  'config-request': [request: ConfigRequest];
  /** Convenience event for a decoded Drive_Status. */
  'drive-status': [status: DriveStatus];
  /** A packet arrived but failed length, checksum or byte-stuffing validation. */
  'packet-error': [error: PacketErrorEvent];
  /** Bytes outside any packet, such as the drive's pre-POST self-test output. */
  discarded: [bytes: Buffer];
  /** An ACK, NAK or SNAK arrived. */
  response: [kind: 'ack' | 'nak' | 'snak'];
  /** The underlying stream failed, or a received message could not be decoded. */
  error: [error: Error];
}

/** Thrown when a packet is not acknowledged after all retries are exhausted. */
export class LdiSendError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
  ) {
    super(message);
    this.name = 'LdiSendError';
  }
}

/** Thrown when an expected response does not arrive in time. */
export class LdiTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LdiTimeoutError';
  }
}

type ResponseKind = 'ack' | 'nak' | 'snak';

export class LdiSession extends EventEmitter<LdiSessionEvents> {
  private readonly decoder = new PacketDecoder();
  private readonly options: Required<LdiSessionOptions>;

  /** Resolver for the ACK/NAK/SNAK the current in-flight packet is waiting on. */
  private pendingResponse: ((kind: ResponseKind) => void) | null = null;

  /**
   * When set, incoming bytes bypass the packet decoder and are handed to this
   * collector instead. Used for the Drive Type primitive, which is exchanged
   * outside the packet protocol.
   */
  private rawCollector: ((chunk: Buffer) => void) | null = null;

  private readonly onData = (chunk: Buffer): void => {
    if (this.rawCollector) {
      this.rawCollector(chunk);
      return;
    }
    for (const event of this.decoder.push(chunk)) {
      this.handleEvent(event);
    }
  };

  private readonly onError = (error: Error): void => {
    this.emit('error', error);
  };

  constructor(
    private readonly stream: LdiStream,
    options: LdiSessionOptions = {},
  ) {
    super();
    this.options = {
      autoAcknowledge: options.autoAcknowledge ?? true,
      sendTimeoutMs: options.sendTimeoutMs ?? Timing.SEND_TIMEOUT_MS,
      retries: options.retries ?? Timing.SEND_RETRIES,
      snakRetries: options.snakRetries ?? Timing.SNAK_RETRIES,
      snakRetryDelayMs: options.snakRetryDelayMs ?? Timing.SNAK_RETRY_DELAY_MS,
    };

    this.stream.on('data', this.onData);
    this.stream.on('error', this.onError);
  }

  /** Detaches the session from its stream. The stream itself is left open. */
  close(): void {
    this.stream.off('data', this.onData);
    this.stream.off('error', this.onError);
    this.decoder.reset();
    this.removeAllListeners();
  }

  /**
   * Sends a message as a packet and waits for it to be acknowledged.
   *
   * Retries on NAK and on timeout, and waits before retrying on SNAK, following
   * the spec's sending rules.
   *
   * @throws {LdiSendError} If the packet is never acknowledged.
   */
  async sendMessage(message: Uint8Array): Promise<void> {
    return this.sendPacket(encodePacket(message));
  }

  /**
   * Sends a pre-encoded packet and waits for it to be acknowledged.
   *
   * Useful for replaying a captured packet byte for byte.
   */
  async sendPacket(packet: Uint8Array): Promise<void> {
    let plainRetriesLeft = this.options.retries;
    let snakRetriesLeft = this.options.snakRetries;
    let attempts = 0;

    for (;;) {
      attempts++;
      await this.write(packet);

      let response: ResponseKind | null;
      try {
        response = await this.waitForResponse(this.options.sendTimeoutMs);
      } catch {
        response = null; // timed out
      }

      if (response === 'ack') {
        return;
      }

      if (response === 'snak') {
        if (snakRetriesLeft-- <= 0) {
          throw new LdiSendError(
            `packet still SNAKed after ${attempts} attempts; the drive stayed too busy to accept it`,
            attempts,
          );
        }
        await delay(this.options.snakRetryDelayMs);
        continue;
      }

      // NAK, or no response before the timeout.
      if (plainRetriesLeft-- <= 0) {
        throw new LdiSendError(
          response === 'nak'
            ? `packet NAKed after ${attempts} attempts; the drive rejected its length or checksum`
            : `no ACK, NAK or SNAK after ${attempts} attempts`,
          attempts,
        );
      }
    }
  }

  /**
   * Sends the Drive Type Request primitive and returns the drive's answer.
   *
   * This exchange sits outside the packet protocol: a single 0x00 byte goes out
   * and nine raw bytes come back, with no framing, checksum or acknowledgement.
   * Because it needs no handshake it works on a drive that has not yet been
   * configured, which makes it the quickest way to prove the RS-422 wiring is
   * right in both directions.
   *
   * @throws {LdiTimeoutError} If nine bytes do not arrive in time.
   */
  async requestDriveType(timeoutMs: number = 3_000): Promise<DriveType> {
    if (this.rawCollector) {
      throw new Error('a raw exchange is already in progress');
    }

    const collected: number[] = [];

    const bytes = await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rawCollector = null;
        reject(
          new LdiTimeoutError(
            `no Drive Type response within ${timeoutMs} ms ` +
              `(received ${collected.length} of ${DRIVE_TYPE_RESPONSE_LENGTH} bytes` +
              (collected.length > 0 ? `: ${formatHexBytes(collected)}` : '') +
              ')',
          ),
        );
      }, timeoutMs);

      this.rawCollector = (chunk: Buffer): void => {
        collected.push(...chunk);
        if (collected.length >= DRIVE_TYPE_RESPONSE_LENGTH) {
          clearTimeout(timer);
          this.rawCollector = null;
          resolve(Buffer.from(collected.slice(0, DRIVE_TYPE_RESPONSE_LENGTH)));
        }
      };

      this.write(DRIVE_TYPE_REQUEST).catch((error: unknown) => {
        clearTimeout(timer);
        this.rawCollector = null;
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });

    // Anything the drive sent beyond the nine bytes belongs to the packet
    // stream; the decoder starts clean on the next inbound chunk.
    this.decoder.reset();

    return parseDriveType(bytes);
  }

  /**
   * Waits for the drive to send its Config_Request.
   *
   * A drive whose feature switches select non-polled mode sends this within ten
   * seconds of power-up or reset.
   *
   * @throws {LdiTimeoutError} If no Config_Request arrives in time.
   */
  async waitForConfigRequest(
    timeoutMs: number = Timing.CONFIG_REQUEST_WINDOW_MS,
  ): Promise<ConfigRequest> {
    return this.waitForEvent('config-request', timeoutMs, 'Config_Request');
  }

  /**
   * Waits for the drive to report its status.
   *
   * In non-polled mode the drive sends a Drive_Status after it accepts a
   * Set_Config that does not require a reset.
   *
   * @throws {LdiTimeoutError} If no Drive_Status arrives in time.
   */
  async waitForDriveStatus(timeoutMs: number = Timing.SEND_TIMEOUT_MS): Promise<DriveStatus> {
    return this.waitForEvent('drive-status', timeoutMs, 'Drive_Status');
  }

  private waitForEvent<K extends 'config-request' | 'drive-status'>(
    event: K,
    timeoutMs: number,
    label: string,
  ): Promise<LdiSessionEvents[K][0]> {
    return new Promise((resolve, reject) => {
      const onEvent = (value: LdiSessionEvents[K][0]): void => {
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        this.off(event, onEvent as never);
        reject(new LdiTimeoutError(`no ${label} received within ${timeoutMs} ms`));
      }, timeoutMs);

      this.once(event, onEvent as never);
    });
  }

  private handleEvent(event: DecodedEvent): void {
    switch (event.kind) {
      case 'ack':
      case 'nak':
      case 'snak':
        this.emit('response', event.kind);
        this.pendingResponse?.(event.kind);
        break;

      case 'packet': {
        // Only the checksum and message length are validated before an ACK is
        // sent, never the message contents, so acknowledge before decoding.
        if (this.options.autoAcknowledge) {
          void this.write(ACK_RESPONSE).catch(this.onError);
        }
        let decoded: LdiMessage;
        try {
          decoded = decodeMessage(event.message);
        } catch (error) {
          this.emit('error', error instanceof Error ? error : new Error(String(error)));
          break;
        }
        this.emit('message', decoded, event.raw);
        if (decoded.kind === 'config-request') {
          this.emit('config-request', decoded);
        } else if (decoded.kind === 'drive-status') {
          this.emit('drive-status', decoded);
        }
        break;
      }

      case 'error':
        if (this.options.autoAcknowledge) {
          void this.write(NAK_RESPONSE).catch(this.onError);
        }
        this.emit('packet-error', event);
        break;

      case 'discarded':
        this.emit('discarded', event.raw);
        break;
    }
  }

  private waitForResponse(timeoutMs: number): Promise<ResponseKind> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResponse = null;
        reject(new LdiTimeoutError(`no ACK, NAK or SNAK within ${timeoutMs} ms`));
      }, timeoutMs);

      this.pendingResponse = (kind: ResponseKind): void => {
        clearTimeout(timer);
        this.pendingResponse = null;
        resolve(kind);
      };
    });
  }

  private write(chunk: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      this.stream.write(chunk, (error) => {
        if (error) {
          reject(error);
          return;
        }
        if (typeof this.stream.drain === 'function') {
          this.stream.drain((drainError) => {
            if (drainError) reject(drainError);
            else resolve();
          });
          return;
        }
        resolve();
      });
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatHexBytes(bytes: Iterable<number>): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}
