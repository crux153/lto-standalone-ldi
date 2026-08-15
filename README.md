# lto-standalone-ldi

Configure an IBM LTO tape drive for **standalone operation** over its RS-422
Library/Drive Interface (LDI), in Node.js and TypeScript.

Drives pulled out of a tape library ship with a configuration bit that keeps
them offline until a library tells them otherwise: the SCSI or Fibre Channel
port never comes up, so the host never sees a tape drive. This tool speaks the
LDI protocol over a USB-to-RS-422 adapter and sends the drive a `Set_Config`
message with **Configuration Flags bit 3 (*Disable automatic drive online*)
cleared**, after which the drive raises its data port by itself on every
power-up.

Protocol reference: [IBM Library/Drive Interface Specification, Revision 4,
January 8 2002 (T10/02-022r0)](https://www.t10.org/ftp/t10/document.02/02-022r0.pdf),
reorganized as an implementation reference in
[`docs/ibm-library-drive-interface.md`](docs/ibm-library-drive-interface.md).

## What it does

- Builds and parses the full LDI packet layer: STX/length/BCC/ETX framing, byte
  stuffing, and ACK/NAK/SNAK handling with the spec's retry rules.
- **Parses and displays the `Config_Request` the drive sends** when it powers up
  in non-polled mode, then answers it with a matching `Set_Config`.
- **Sends a Drive Type Request and verifies the drive answers `"IBM"`** — the
  fastest way to prove your RS-422 wiring is right, because it needs no
  handshake and no packet framing.
- Decodes `Drive_Status`, so you can see cartridge state, LED, tape motion,
  TapeAlert flags and whether the drive is online.
- Reproduces the field-proven `Set_Config` packet byte for byte, verified by
  unit tests against both published captures.

## Before you start

1. **Set every DIP switch on the drive to off.** This selects non-polled mode,
   in which the drive starts the handshake itself by sending a `Config_Request`
   within ten seconds of power-up.
2. Wire a USB-to-RS-422 adapter to the drive's LDI connector, a JST-SH 1.0 mm
   10-pin header. Pin 1 is on the left looking at the connector from behind:

   | Drive pin | Signal | Connect to adapter |
   | --------- | ------ | ------------------ |
   | 1         | RX+    | TX+                |
   | 2         | RX-    | TX-                |
   | 3         | GND    | GND                |
   | 4         | TX-    | RX-                |
   | 5         | TX+    | RX+                |

   The pairs cross over: the adapter transmits into the drive's receiver and
   vice versa. If you are cutting into an existing library cable instead, the
   colours reported for one such harness were TxD+ → red, TxD- → brown,
   RxD+ → yellow, RxD- → orange, GND → black.
3. The line runs at **38400 8N1** by default (the drive also supports 9600, and
   1 or 2 stop bits, both selected by feature switches).

## Install

```bash
npm install
npm run build
```

## Use

Check the wiring first. This needs no handshake, so it works on a drive that has
never been configured:

```bash
npx lto-ldi drive-type --port /dev/ttyUSB0
```

```
Sending Drive Type Request (0x00)...
Drive Type (primitive response, 9 bytes)
  Raw                : FA 49 42 4D 80 4B 39 41 30
  Header byte        : 0xFA
  Vendor             : "IBM"
  Device byte        : 0x80
  Firmware revision  : 4B 39 41 30 ("K9A0")
  Verdict            : OK - drive identifies itself as IBM
```

The command exits non-zero if the drive does not identify itself as IBM, and
prints exactly which bytes disagreed.

Watch what the drive says on power-up, including its `Config_Request`:

```bash
npx lto-ldi monitor --port /dev/ttyUSB0
```

Then do the actual job — wait for the drive to ask for its configuration and
answer with a `Set_Config` that clears bit 3:

```bash
npx lto-ldi standalone --port /dev/ttyUSB0
```

```
Waiting up to 10000 ms for a Config_Request.
Power-cycle the drive now if it is already running.

Config_Request (Drive-to-Library, Type=0xAB, Subtype=0x01)
  Raw                : AB FF 03 00 00 2A 01
  Msg Type           : 0xAB (Two_Way)
  Tgt Addr           : 0xFF (library)
  Msg ID             : 03 00 00 2A
    originator LDI   : 0x03 (drive 3)
    key              : 00 00 2A
  Msg Subtype        : 0x01 (Config_Request)
  Meaning            : the drive is asking the library for its configuration.
                       Reply with a Set_Config carrying these same Msg ID bytes.

Sending Set_Config
  ...
Drive acknowledged the Set_Config (ACK).
```

The drive resets itself after bit 3 changes — the spec allows up to a minute —
and comes back with its SCSI or Fibre Channel port online.

### How this compares to the packet the write-ups publish

Both write-ups send their packet blind, without waiting for the drive to ask.
That is what `--async` does, and with no other options it puts exactly those 60
bytes on the wire:

```
02 00 36 AC 01 00 00 00 01 FF F2 00 ...(47 zero bytes)... E6 03
```

The default `standalone` waits for the `Config_Request` first, so its packet
differs in **three wire bytes** — and it has to. The spec requires the reply to
echo the request's four Msg ID bytes, and those bytes are chosen by the drive:

| Wire offset | Field | Reference | Answering a request |
| ----------- | ----- | --------- | ------------------- |
| 5, 8 | Msg ID (echoed from the `Config_Request`) | `00 00 00 01` | whatever the drive sent |
| 58 | BCC (follows from the Msg ID) | `E6` | recomputed |

Everything else is identical, including Configuration Flags byte 53 = `0x00`
with bit 3 clear. Use `--async` if you want the published packet verbatim;
otherwise the default is the more correct of the two, because a drive that just
asked for its configuration gets an answer it can match to its request.

Other commands:

```bash
npx lto-ldi list-ports                                  # find the adapter
npx lto-ldi standalone --port /dev/ttyUSB0 --async      # library-initiated handshake
npx lto-ldi set-config --port /dev/ttyUSB0 --drive-address 3
npx lto-ldi build                                       # print the packet, no hardware
npx lto-ldi build --reference                           # print the published packet
npx lto-ldi decode "02 00 36 AC ..."                    # decode a capture
npx lto-ldi --help
```

To put a drive back under library control, set bit 3 again with
`--library-mode`.

## As a library

```ts
import { LdiSession, buildSetConfigResponse, encodePacket } from 'lto-standalone-ldi';
import { SerialPort } from 'serialport';

const port = new SerialPort({ path: '/dev/ttyUSB0', baudRate: 38400 });
const session = new LdiSession(port);

// Verify the drive is an IBM drive (no handshake needed).
const driveType = await session.requestDriveType();
console.log(driveType.vendor, driveType.isIbmDrive); // "IBM" true

// Answer the drive's Config_Request. The reply must echo its four Msg ID bytes,
// which buildSetConfigResponse does for you.
const request = await session.waitForConfigRequest();
await session.sendMessage(buildSetConfigResponse(request, { tgtAddr: 0x01 }));
```

`LdiSession` takes any duplex byte stream, not just a `SerialPort`, so it can be
driven against a fake in tests.

## Protocol notes

### Packet format

```
STX   L1 L2    Message                       BCC    ETX
0x02  2 bytes  6..507 bytes before stuffing  1 byte 0x03
```

`L1 L2` counts message bytes only, high-order byte first. The BCC is the low
byte of the sum of `L1`, `L2` and every message byte. ACK (`0x06`), NAK
(`0x15`) and SNAK (`0x1A`) are not packets — each is that byte followed by ETX.

### Byte stuffing, and the checksum that looks wrong

After the length and BCC have been computed, `0x02` is sent as `FF F2`, `0x03`
as `FF F3` and `0xFF` as `FF FF`, so the only `0x02`/`0x03` on the wire are the
real STX and ETX.

This is what makes the well-known reference packet confusing:

```
02 00 36 AC 01 00 00 00 01 FF F2 00 ...(47 zero bytes)... E6 03
```

The `FF F2` in the middle is not a message field. It is the stuffed form of the
single byte `0x02` at message offset 6 — the *Interface Version Major* field.
Unstuffed, the message is exactly the 54 bytes the length field claims, and the
BCC checks out:

```
0x00 + 0x36 + 0xAC + 0x01 + 0x01 + 0x02 = 0x1E6  ->  0xE6
```

Summing the bytes as they appear on the wire instead gives `0xD5`, which is why
the Japanese write-up below reports a checksum mismatch it could not account
for. There is no mismatch; the checksum covers the unstuffed bytes.

The spec is internally inconsistent about whether the BCC itself is stuffed: the
"Byte Stuffing" section names it alongside the length and message bytes and
promises that no stray `0x02`/`0x03` can appear, while the later sending and
receiving rules mention only the length and message. This implementation stuffs
the BCC, since that is the only reading under which a BCC of `0x03` cannot be
mistaken for the closing ETX.

### Set_Config layout

| Byte(s) | Field |
| ------- | ----- |
| 0       | Msg Type (`0xAC`) |
| 1       | Tgt Addr — the drive's LDI address |
| 2–5     | Msg ID — echo the `Config_Request`'s bytes exactly |
| 6       | Interface Version Major (`0x02`) |
| 7       | Interface Version Minor (`0x00`) |
| 8–25    | Reserved |
| 26      | Drive FC/SCSI Address |
| 27–52   | Reserved |
| 53      | **Configuration Flags** |
| 54      | Library Information Field |
| 55–62   | Drive Fibre Channel World Wide Node Name |
| 63      | Reserved |

Configuration Flags (byte 53):

| Bit | Meaning when set |
| --- | ---------------- |
| 7   | Non-polled mode |
| 6   | Disable softload |
| 5   | Disable SCSI eject |
| 4   | Disable automatic eject of FMR or cleaner tape |
| 3   | **Disable automatic drive online** — clear this for standalone |
| 2–0 | Reserved |

Messages stop after byte 53 by default. The spec's Interface Scenarios note that
"all drive firmware levels accept bytes 0-53 of the Set_Config", so the 54-byte
form works regardless of firmware; pass `--full` for all 64 bytes.

### Drive Type Request

A single `0x00` byte, sent outside the packet protocol entirely — no framing,
checksum, acknowledgement or byte stuffing. The drive replies with nine bytes:

| Byte(s) | Value |
| ------- | ----- |
| 0       | `0xFA` |
| 1–3     | `0x49 0x42 0x4D` — ASCII `IBM` |
| 4       | `0x80` |
| 5–8     | Firmware revision, MSB first |

## Tests

```bash
npm test
```

The suite verifies, among other things, that the packet this library builds is
byte-for-byte identical to the one published in both write-ups below, that the
BCC matches the spec's own worked example (Figure 3), that byte stuffing
round-trips every byte value, and that the `Config_Request` → `Set_Config` →
`Drive_Status` handshake runs correctly against an in-memory drive.

## Safety

`Set_Config` writes to the drive's non-volatile storage and makes it reset
itself. Nothing here touches tape media, but changing the drive's LDI address or
FC/SCSI address will change how a host sees it. Read what `build` prints before
sending anything.

## Credits

The wiring and the working packet were worked out and published by others; this
project implements the protocol properly around them.

- [AC7RNsphnHVbyT4/ibm-tape-drive-automatic-standalone](https://github.com/AC7RNsphnHVbyT4/ibm-tape-drive-automatic-standalone)
  — oscilloscope-traced pinout, the reference packet, and the trick of sending
  `0x00` to find the drive's transmit pair.
- [piro400's diary — 個人でLTOを使ってみた(その4)](https://piro400.hatenablog.com/entry/2024/08/26/213949)
  — JST-SH 10-pin pinout and an independent replay of the same packet.
- [T10/02-022r0](https://www.t10.org/ftp/t10/document.02/02-022r0.pdf) — the
  IBM Library/Drive Interface Specification itself, contributed to T10 by IBM.

## License

MIT
