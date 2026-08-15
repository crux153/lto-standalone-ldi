# IBM Library/Drive Interface (LDI) Specification

**Source:** IBM Library/Drive Interface Specification, Revision 4 (T10/02-022r0), January 8, 2002.

This document describes the library/drive interface (LDI) of IBM LTO tape drives: a serial
command/status channel between a tape drive and the library subsystem it is installed in.
Content is reorganized here as an implementation reference — physical layer, framing, then
message-by-message byte layouts.

---

## 1. Overview

The LDI provides direct communication of commands and status between an LTO tape drive and the
library. It allows the library to configure a drive for operation, allows the drive to report status,
and serves as a service communication path for offline service functions driven from the library
operator panel.

- One cable attachment per installed tape drive.
- The drive's data path (SCSI or Fibre Channel) is separate from the LDI control path.

```
   Drive 1            Drive 2
     |                  |
    LDI                LDI          <- library control path
     |                  |
  +--------------------------+
  |         Library          |
  +--------------------------+
     |                  |
   SCSI               SCSI          <- drive data path (to host)
```

### 1.1 Polled vs. non-polled mode

Every drive reset requires a handshaking startup process (Section 9). During that process the LDI is
configured for one of two modes. The power-on default is selectable by a feature switch on the drive.

| Mode | Behavior |
|---|---|
| Non-polled | Either side may initiate communication at any time. The drive sends unsolicited messages (e.g. `Config_Request`, `Drive_Status`). |
| Polled | Only the library may initiate communication. The drive will not initiate LDI communication again until the next reset (if the default is non-polled) or until the mode is changed. |

Polled mode is intended for designs with a multiplexed or shared LDI line, or where the library does
not support queueing of requests.

---

## 2. Physical Layer

RS-422, full duplex, asynchronous (simultaneous transmit/receive).

| Parameter | Value |
|---|---|
| Baud rate | 9600 or 38400 (selectable via drive feature switch) |
| Data bits | 8 |
| Parity | None |
| Stop bits | 1 or 2 (selectable via drive feature switch) |

The connector and signal pinout are defined in the applicable drive product specification.

---

## 3. Primitives

Two byte sequences fall outside the packet protocol entirely: there is no STX, length, checksum, ETX,
acknowledgement, or byte stuffing for them. They exist so a library can detect which drive type is
attached before speaking the packet protocol.

### 3.1 Drive Type Request (Library → Drive)

A single byte: `0x00`.

### 3.2 Drive Type (Drive → Library)

A 9-byte response to Drive Type Request.

| Byte | Value / Description |
|---|---|
| 0 | `0xFA` |
| 1 | `0x49` (ASCII `I`) |
| 2 | `0x42` (ASCII `B`) |
| 3 | `0x4D` (ASCII `M`) |
| 4 | `0x80` |
| 5 (MSB) … 8 (LSB) | Firmware Revision (4 bytes) |

---

## 4. Packet Protocol

All other communication is framed in packets. Same line settings as Section 2 (8 data bits, no parity,
1 or 2 stop bits).

### 4.1 Control characters

| Char | Hex | Meaning | Description |
|---|---|---|---|
| STX | `0x02` | Start of Text | Beginning of packet text. |
| ETX | `0x03` | End of Text | End of packet text. |
| ACK | `0x06` | Positive Acknowledgement | Packet received; ready for next packet. Only the checksum and message length are validated before sending ACK — **not** the message contents. |
| NAK | `0x15` | Negative Acknowledgement | Packet received incorrectly; sender retransmits immediately, up to 3 retries. Sent after a checksum error or message length error (on the library side, possibly also on a receive time-out). |
| SNAK | `0x1A` | Special Negative Acknowledgement | Receiver is too busy to handle more LDI traffic. Sender waits 10 seconds and retransmits, up to 10 retries, before reporting an error. |

**NAK during startup:** after power-up or reset, the drive returns NAK for most messages from the
library until the handshaking startup process completes. If retries in response to a NAK keep failing,
the library should run the handshaking startup process (Section 9).

### 4.2 Packet format

| Field | Size | Description |
|---|---|---|
| STX | 1 byte | `0x02` |
| L1 L2 | 2 bytes | Message data byte count, big-endian (L1 = high-order byte, sent first). Excludes STX, L1, L2, BCC, and ETX. |
| Message | 6–507 bytes (before byte stuffing) | The message (Section 5). |
| BCC | 1 byte | Block-check character (checksum). |
| ETX | 1 byte | `0x03` |

ETX is always required as the final byte of any packet — including ACK, NAK, and SNAK. Those three
responses are therefore exactly two bytes: the control character followed by ETX.

Only ETX is added to ACK/NAK/SNAK; they carry no STX, length, or BCC.

### 4.3 Block-check character (BCC)

1. Treat each byte as an integer 0–255.
2. Sum the bytes starting with (and including) L1 and L2, and ending with (and including) the last
   byte of the Message. STX, ETX, and BCC are **not** included.
3. Take the sum modulo 256 — equivalently `SUM & 0xFF` — as the single-byte checksum.

### 4.4 Byte stuffing

Byte stuffing keeps literal `0x02` and `0x03` values inside the length bytes, message bytes, or BCC
from being mistaken for STX and ETX.

Stuffing is applied to a packet that is otherwise complete: L1/L2 computed and placed, message
placed, BCC computed and placed. STX and ETX may be added before or after stuffing; their values are
never altered by it.

**Stuffing does not affect the length or BCC calculations.** Both are computed on the unstuffed data.
STX, ETX, ACK, NAK, and SNAK are the only characters not subject to change by byte stuffing.

| When transmitting, convert | to |
|---|---|
| `0x02` | `0xFF 0xF2` |
| `0x03` | `0xFF 0xF3` |
| `0xFF` | `0xFF 0xFF` |

| When receiving, convert | to |
|---|---|
| `0xFF 0xF2` | `0x02` |
| `0xFF 0xF3` | `0x03` |
| `0xFF 0xFF` | `0xFF` |

While unstuffing, a `0xFF` followed by any value other than `0xF2`, `0xF3`, or `0xFF` is undefined and
may be treated as an error; respond with NAK.

**Example.** Packet to be sent:

```
STX   L1    L2    Message bytes   BCC   ETX
0x02  0x00  0x02  0x23 0xFF       0x24  0x03
```

What actually goes on the wire:

```
STX   L1    L2 (stuffed)  Message (stuffed)   BCC   ETX
0x02  0x00  0xFF 0xF2     0x23 0xFF 0xFF      0x24  0x03
```

The BCC and the length bytes are computed before the packet is modified. After stuffing, it is
guaranteed that no `0x02` or `0x03` appears in the packet except as STX and ETX.

### 4.5 Sending packets

The values below characterize the IBM drive implementation; both library and drive have discretion
over retry counts and timeout values.

1. Format the packet per Section 4.2: add STX, length, BCC, and ETX to the message (only ETX for
   ACK/NAK/SNAK). Then apply byte stuffing to the length and message bytes.
2. Start a 5-second timeout after the last character of the packet is sent. An ACK, NAK, or SNAK must
   arrive before it expires. On timeout, retry the send up to 3 times. Also retry up to 3 times on
   NAK, and up to 10 times on SNAK (waiting 10 seconds before each SNAK retry). SNAK indicates the
   receiver was too busy and asked for a delayed retry. If all retries fail, the send ends in error.
3. Do not send a second packet until an ACK, NAK, or SNAK has been received for the previous packet,
   or until the timeout has expired.
4. Handle duplicate responses — e.g. an ACK/NAK/SNAK arriving after the response timer expired. Use
   the Msg ID field to correlate in single-packet cases, and Msg ID plus Section Number for
   multi-packet messages.

### 4.6 Receiving packets

1. A 1024-byte buffer is required to receive the largest single-packet transmission, because of byte
   stuffing. Unstuffing can be done on the fly as the packet arrives, which lowers buffer
   requirements and spreads out unstuffing work. On-the-fly unstuffing means the receiver may need to
   maintain extra packet delineation state, since `0x02` and `0x03` can appear inside the packet
   without being STX/ETX.
2. Ignore all characters preceding STX, except ACK, NAK, and SNAK. A partial packet prepended to a
   full packet still results in NAK, because L1/L2 will not match the combined message length. (This
   rule is what causes a library to discard the drive's pre-power-on-reset self-test bytes — none of
   them are STX.) Delineating packets by searching for ETX only is permissible; in that case ACK, NAK,
   and SNAK must be immediately followed by ETX, all other packets must start with STX, and length and
   BCC checks establish validity.
3. After the terminating ETX, unstuff the length and message bytes and check the BCC. If the length or
   checksum is wrong, respond with NAK (followed by ETX). If too busy to handle the packet at all,
   respond with SNAK (followed by ETX). The IBM drive never sends SNAK, but does process SNAKs from a
   library.
4. If ETX was received and length and checksum are correct, respond with ACK (followed by ETX). If the
   library receives a message type not listed in Section 6, it should simply return ACK and take no
   further action.
5. Receive timeout: the IBM drive does not implement one. If it receives a partial packet, no response
   is returned until a subsequent ETX arrives (from a later packet), after which an L1/L2 mismatch on
   the aggregate produces a NAK. Either side may implement a receive timeout; 10 seconds for packet
   completion after the first character is a workable value, with failure producing a NAK and the
   partial packet discarded. **The receive timeout must be shorter than the send timeout.** Send NAKs
   immediately after receiving an ETX (when a NAK is appropriate); NAKs sent at other times should be
   ignored.
6. Messages are sent one at a time. For a message requiring a response, no further message may be
   started until that response arrives. For a message not requiring a response, no further message may
   be started until sending completes and ACK is received. **One exception:** the drive will receive
   and respond to `Drive_Status_Request` even while working on another command it owes a response to.

### 4.7 Implementation notes

- Timeouts and retry counts may vary; the values above are typical and have been used in shipping
  implementations.
- Receive and transmit logic must be implemented so that race conditions between near-simultaneous
  received and transmitted packets cannot deadlock. Once a packet is received, an ACK/NAK/SNAK must be
  sent; it must not interrupt a packet currently being transmitted, but should immediately follow it
  (before the ACK/NAK/SNAK for the transmitted packet is received).
- Never drop received characters. A packet may be received immediately followed by the ACK/NAK/SNAK
  for a previously or concurrently sent packet. That response must be routed to the transmit logic
  promptly to prevent a timeout and retransmit. Even with no character loss there is an implicit race,
  handled by receiver logic that filters duplicate valid received packets.

### 4.8 Pre-power-on-reset noise

Before the drive completes power-on reset, it may transmit a byte sequence ending in ETX (`0x03`) as
part of its self-test procedure, at both power-up and reset. That sequence does not conform to the
packet protocol and the protocol discards it as invalid, so higher-level message handling never sees
those bytes. Any library or drive implementation that runs a self-test or diagnostic sequence, or
otherwise transmits from the serial port, should emit an ETX (`0x03`) before the first meaningful
message.

---

## 5. Message Format

The Message field of a packet has this general layout:

| Byte | Description |
|---|---|
| 0 | Msg Type |
| 1 | Tgt Addr |
| 2 … 5 | Msg ID |
| 6 … n | Message Data (variable length) |

**Msg Type (Message Type).** One byte defining the format of the message data. Only two types exist
(Section 6), to co-exist with legacy IBM library/drive interfaces. The `Two_Way` type is further
divided into subtypes. "Message" is used generically below for both types and subtypes.

**Tgt Addr (Target LDI Address).** One byte identifying the intended target.

- When the library is the target, the LDI address is always `0xFF`.
- For a target drive, the address is in the range `0x01` to the maximum drive number (up to `0xFE`).
- The address should be unique per drive on a common library controller; it is set by the library via
  `Set_Config`. Uniqueness aids debugging and allows more rigorous packet integrity checking.

**Msg ID (Message ID).** Four bytes identifying a particular packet. The first byte is the LDI address
of the original message source. The remaining three bytes provide a unique key so the source can
associate responses with two or more outstanding messages. Any response message (e.g.
`Maint_Status_Good`) carries these 4 bytes unaltered from the original message.

**Message Data.** Contents determined by Msg Type. For `Two_Way`, the first byte of Message Data
(packet byte 6) is the Message Subtype.

---

## 6. Message Types and Subtypes

### 6.1 Message types

| Value | Message Type | Direction | Description |
|---|---|---|---|
| `0xAB` | Two_Way | Library→Drive, Drive→Library | First byte of Message Data is a message subtype (Section 6.2). |
| `0xAC` | Set_Config | Library→Drive | Library configuration information; sent asynchronously or as a response to `Config_Request`. |

### 6.2 Two_Way message subtypes

| Value | Message Subtype | Direction | Description |
|---|---|---|---|
| `0x01` | Config_Request | Drive→Library | Request for library configuration; library responds with `Set_Config`. |
| `0x30` | Maint_Command | Library→Drive | Request for drive operation, identity, status, logs, or firmware. |
| `0x3C` | Maint_Status_Good | Drive→Library | Response to `Maint_Command`, with optional data. |
| `0x3F` | Maint_Status_Error | Drive→Library | Response to `Maint_Command`, with error sense data. |
| `0x40` | Drive_Status | Drive→Library | Drive status; asynchronous or response to `Drive_Status_Request`. |
| `0x41` | Drive_Status_Request | Library→Drive | Request for drive status; drive responds with `Drive_Status`. |

---

## 7. Configuration Messages

### 7.1 Config_Request (Drive → Library, Type `0xAB`, Subtype `0x01`)

After power-up or reset, the drive returns NAK for any `Two_Way` message from the library until the
handshaking startup process completes. If the interface default is non-polled mode (set by drive
feature switches), the drive starts the handshake by sending `Config_Request`, **within 10 seconds**
of power-up or reset. For polled-mode defaults, see Section 9.2.

| Byte | Description |
|---|---|
| 0 | Msg Type (`0xAB`) |
| 1 | Tgt Addr (`0xFF`) |
| 2 … 5 | Msg ID |
| 6 | Msg Subtype (`0x01`) |

### 7.2 Set_Config (Library → Drive, Type `0xAC`)

Sent asynchronously by the library, or as a response to `Config_Request`.

> **When responding to a `Config_Request`, all four Msg ID bytes must be identical to those in the
> `Config_Request`** — even though the drive LDI address may no longer be valid, e.g. for a drive
> just moved from one position to another. A change to the drive LDI address is communicated through
> the Tgt Addr field of this message.

| Byte | Description |
|---|---|
| 0 | Msg Type (`0xAC`) |
| 1 | Tgt Addr |
| 2 … 5 | Msg ID |
| 6 | Interface Version Major (`0x02`) |
| 7 | Interface Version Minor (`0x00`) |
| 8 … 25 | Reserved (18 bytes) |
| 26 | Drive FC/SCSI Address |
| 27 … 52 | Reserved (26 bytes) |
| 53 | Configuration Flags |
| 54 | Library Information Field |
| 55 (MSB) … 62 (LSB) | Drive Fibre Channel World Wide Node Name |
| 63 | Reserved |

**Drive FC/SCSI Address (byte 26).** How the library supplies the I/O address to the drive.

- SCSI: valid addresses 0–15.
- Fibre Channel: the address is a **Loop ID**, not an AL_PA. Valid addresses 0–127.
- Fibre Channel values 126 or 127 select soft addressing mode. Not recommended, except in the highly
  unlikely case that a host device driver / HBA installation explicitly requires it.

**Configuration Flags (byte 53).**

| Bit | Name | Values |
|---|---|---|
| 7 | Non-Polled Mode | 0 = configure LDI for polled mode; 1 = configure LDI for non-polled mode |
| 6 | Disable Softload | 0 = enable drive softload capability (SCSI Mode Page settings may apply); 1 = disable it. Takes precedence over any SCSI Mode Page setting enabling softload, but no SCSI mode pages are changed (ref. T10/99-347r1, Autoload Mode field). |
| 5 | Disable SCSI Eject | 0 = enable eject on SCSI Unload command (SCSI Unload CDB options may apply); 1 = disable it. Takes precedence over any SCSI Unload CDB option to perform the eject (ref. T10/99-347r1). |
| 4 | Disable automatic eject of FMR or Cleaner tape after command | 0 = automatic eject enabled; 1 = disabled |
| 3 | Disable automatic drive online | 0 = drive goes online to SCSI or Fibre Channel automatically without needing `Set_Config`; 1 = drive requires a `Set_Config` to go online |
| 2–0 | Reserved | |

**Library Information Field (byte 54).** Relayed to the SCSI host in every Request Sense response
(error and non-error), in parameter data byte 35.

**Drive Fibre Channel World Wide Node Name (bytes 55–62).** Used by the drive to set its Fibre Channel
port name(s) and node name, letting the library own these values. A value of zero instructs the drive
to use its own world wide names.

**Fields that may cause the drive to reset itself:**

- First-ever receipt of this command for any drive model
- Drive LDI Address (Tgt Addr)
- Drive FC/SCSI Address
- Drive Fibre Channel World Wide Node Name
- Configuration Flags bit 3, Disable automatic drive online

**Fields the drive stores in non-volatile storage:**

- Drive LDI Address (Tgt Addr)
- Drive FC/SCSI Address
- Configuration Flags bit 3, Disable automatic drive online
- Library Information Field
- Drive Fibre Channel World Wide Node Name

### 7.3 Drive FC/SCSI address handling during power-on reset

Controlled by `Set_Config` Configuration Flags bit 3 (Disable automatic drive online). When the drive
is configured to expect its SCSI or Fibre Channel address from the LDI (see the applicable drive
product specification), at power-on reset it does one of the following:

- **Bit 3 set in non-volatile storage:** the drive stays offline — it does not respond to Selection on
  the SCSI bus and does not participate in the Fibre Channel loop — until it receives a `Set_Config`
  with a valid address. This greatly reduces the chance of a replacement (unconfigured) drive causing
  address conflict errors during concurrent drive maintenance ("hot swap").
- **Bit 3 not set:** the drive sets its address to that of the prior `Set_Config` and goes online.

---

## 8. Maintenance and Status Messages

### 8.1 Maint_Command (Library → Drive, Type `0xAB`, Subtype `0x30`)

Requests one of a set of pre-defined operations (sub-commands). The drive responds with
`Maint_Status_Good` or `Maint_Status_Error`, with data as appropriate.

`Maint_Command` grants the drive **implicit permission to use the LDI** when its
`Maint_Status_Good`/`Maint_Status_Error` response is ready, even when the LDI is in polled mode.

Despite the name, usage extends beyond maintenance/service activities. Any of these commands may be
issued at any time, though a library design may require some of them to be used only while the library
is offline (not ready).

| Byte | Description |
|---|---|
| 0 | Msg Type (`0xAB`) |
| 1 | Tgt Addr |
| 2 … 5 | Msg ID |
| 6 | Msg Subtype (`0x30`) |
| 7 | Maintenance Sub-command |
| 8 … n | Parameter data (per sub-command) |

#### Maintenance sub-commands (byte 7)

| Value | Sub-command | Notes |
|---|---|---|
| `0x00` | Device Offline | Section 8.2 |
| `0x01` | Device Online | Section 8.3 |
| `0x10` | Read Standard Inquiry Data | Requests SCSI Standard Inquiry data. |
| `0x11` | Read Request Sense Data | Requests SCSI Request Sense data. Does **not** clear SCSI error sense for any initiator. The drive queues multiple errors, so the library may need to request sense repeatedly until sense data indicates no additional errors. |
| `0x12` | Read Device Identification Data | Requests SCSI Inquiry Page `0x83`, so a SCSI library can support SCSI-3 Read Element Status with DVCID=1. |
| `0x20` | Set Drive Serial Number | Section 8.4 |
| `0x30` | Unload Drive | Section 8.5 |
| `0x31` | Load Drive | Section 8.6 |
| `0x50` | Perform Read/Write Test | Destructive. Must be issued after a scratch cartridge is loaded. Takes 1–5 minutes. |
| `0x51` | Perform Head Test | Destructive. Must be issued after a scratch cartridge is loaded. Takes 5–10 minutes. |
| `0x52` | Perform Media Test | Destructive. Must be issued after a scratch cartridge is loaded. Takes 5–10 minutes. |
| `0x53` | Short Read/Write Diagnostic | Quick diagnostic of reading and writing. A cartridge is required. |
| `0x55` | Perform Self-Test | No cartridge required. |
| `0x60` | Firmware Update From FMR Cartridge | Must be issued immediately **before** the FMR cartridge is loaded. The drive allows 60 seconds from the time the command is issued until the cartridge is successfully loaded and comes ready. |
| `0x61` | Create Drive FMR Cartridge | Must be issued immediately **after** the scratch cartridge is loaded. |
| `0x62` | Erase Drive FMR Cartridge | Must be issued immediately **before** the FMR cartridge is loaded. Same 60-second window as `0x60`. |
| `0x63` | Read Buffer | Section 8.7 |
| `0x64` | Write Buffer | Section 8.8 |
| `0x65` | Read Tape | Section 8.9 |
| `0x66` | Write Tape | Section 8.10 |
| `0x70` | Write Drive Dump to Tape | Must be issued immediately after a scratch cartridge is loaded. |
| `0x71` | Force Drive Dump | |
| `0x80` | Reset Drive | |
| `0x81` | Force Check One Dump and Reset Drive | |
| `0x90` | SCSI Wrap Test | See the applicable drive Setup, Operator, & Service Guide for when to insert and remove the wrap tool. |
| `0xB0` | Setup Forced Error Logging | |
| `0xB5` | Read Log Sense Data | Section 8.11 |
| `0xC0` | Set Traps | Section 8.12 |
| `0xC1` | Remove Traps | Section 8.13 |

### 8.2 Maint_Command — Device Offline (`0x00`)

Takes the drive offline on the SCSI bus. Any attempt to select the drive while offline results in a
selection timeout. If a SCSI command is in progress, or if the drive does not go offline within 60
seconds of receiving this command, the drive responds with an error.

| Byte | Description |
|---|---|
| 0 | Msg Type (`0xAB`) |
| 1 | Tgt Addr |
| 2 … 5 | Msg ID |
| 6 | Msg Subtype (`0x30`) |
| 7 | Maintenance Sub-command (`0x00`) |

### 8.3 Maint_Command — Device Online (`0x01`)

Brings the drive online on the SCSI bus so it responds to selection again. The drive is "guaranteed"
to go online.

| Byte | Description |
|---|---|
| 0 | Msg Type (`0xAB`) |
| 1 | Tgt Addr |
| 2 … 5 | Msg ID |
| 6 | Msg Subtype (`0x30`) |
| 7 | Maintenance Sub-command (`0x01`) |

### 8.4 Maint_Command — Set Drive Serial Number (`0x20`)

Writes a 12-byte serial number into drive VPD, followed by a 1-byte checksum of those 12 bytes.

| Byte | Description |
|---|---|
| 0 | Msg Type (`0xAB`) |
| 1 | Tgt Addr |
| 2 … 5 | Msg ID |
| 6 | Msg Subtype (`0x30`) |
| 7 | Maintenance Sub-command (`0x20`) |
| 8 (MSB) … 19 (LSB) | Drive Serial Number (12 bytes, ASCII) |
| 20 | Checksum for Drive Serial Number |

### 8.5 Maint_Command — Unload Drive (`0x30`)

Followed by one **optional** parameter byte. If omitted, it is treated as `0x00`.

| Byte | Description |
|---|---|
| 0 | Msg Type (`0xAB`) |
| 1 | Tgt Addr |
| 2 … 5 | Msg ID |
| 6 | Msg Subtype (`0x30`) |
| 7 | Maintenance Sub-command (`0x30`) |
| 8 | Unload Options (optional) |

**Unload Options (byte 8)**

| Bit | Name | Values |
|---|---|---|
| 7–2 | Reserved | |
| 1 | Disable Eject | 0 = unthread and eject; 1 = unthread only, do not eject |
| 0 | Immediate Response | 0 = respond with `Maint_Status_Good`/`Maint_Status_Error` when the unload completes; 1 = respond with `Maint_Status_Good` immediately, and the library may poll for completion using `Drive_Status_Request` |

### 8.6 Maint_Command — Load Drive (`0x31`)

Followed by one parameter byte.

| Byte | Description |
|---|---|
| 0 | Msg Type (`0xAB`) |
| 1 | Tgt Addr |
| 2 … 5 | Msg ID |
| 6 | Msg Subtype (`0x30`) |
| 7 | Maintenance Sub-command (`0x31`) |
| 8 | Load Options |

**Load Options (byte 8)**

| Bit | Name | Values |
|---|---|---|
| 7–2 | Reserved | |
| 1 | Disable Thread | 0 = load and thread; 1 = load only, do not thread |
| 0 | Immediate Response | 0 = respond with `Maint_Status_Good`/`Maint_Status_Error` when the load completes; 1 = respond with `Maint_Status_Good` immediately, and the library may poll for completion using `Drive_Status_Request` |

### 8.7 Maint_Command — Read Buffer (`0x63`)

Followed by 7 parameter bytes selecting the buffer, the offset within it, and the maximum amount of
buffer data to return in the response. For further detail, see the applicable tape drive SCSI
reference.

| Byte | Description |
|---|---|
| 0 | Msg Type (`0xAB`) |
| 1 | Tgt Addr |
| 2 … 5 | Msg ID |
| 6 | Msg Subtype (`0x30`) |
| 7 | Maintenance Sub-command (`0x63`) |
| 8 | Buffer ID |
| 9 (MSB) … 11 (LSB) | Buffer Offset |
| 12 (MSB) … 14 (LSB) | Allocation Length |

**Buffer IDs for Read Buffer**

| Buffer ID | Definition |
|---|---|
| 0 and 4 (use buffer 4 — buffer 0 may change) | Firmware image from non-volatile storage |
| 1 | Firmware trace (dump) from DRAM |
| 2 | Test buffer |
| 3 | Entire VPD image from DRAM |
| 5 | Entire CM. Information is provided even if no tape is loaded — whatever is stored in DRAM. |
| 6 | Drive error log |

### 8.8 Maint_Command — Write Buffer (`0x64`)

Followed by 6 parameter bytes and the data to be written: the target buffer, the offset within it, and
the amount of data included in the message. For further detail, see the applicable tape drive SCSI
reference.

| Byte | Description |
|---|---|
| 0 | Msg Type (`0xAB`) |
| 1 | Tgt Addr |
| 2 … 5 | Msg ID |
| 6 | Msg Subtype (`0x30`) |
| 7 | Maintenance Sub-command (`0x64`) |
| 8 | Buffer ID |
| 9 (MSB) … 11 (LSB) | Buffer Offset |
| 12 (MSB) … 13 (LSB) | Parameter List Length (= n − 13) |
| 14 … n | Parameter List Data |

**Buffer IDs for Write Buffer**

| Buffer ID | Definition |
|---|---|
| 0 and 4 (use buffer 4 — buffer 0 may change) | Firmware image to non-volatile storage. Currently the drive does not reset after the write completes. |
| 2 | Test buffer |
| 6 | Clears the drive error log. Any data sent is ignored, as is the size of that data. |

### 8.9 Maint_Command — Read Tape (`0x65`)

Followed by 3 parameter bytes giving the maximum amount of tape data to return. The drive reads from
beginning-of-tape until one of these occurs: a filemark is detected, end-of-data is detected, or the
maximum amount of data (Allocation Length) has been sent.

| Byte | Description |
|---|---|
| 0 | Msg Type (`0xAB`) |
| 1 | Tgt Addr |
| 2 … 5 | Msg ID |
| 6 | Msg Subtype (`0x30`) |
| 7 | Maintenance Sub-command (`0x65`) |
| 8 (MSB) … 10 (LSB) | Allocation Length |

### 8.10 Maint_Command — Write Tape (`0x66`)

Writes to a scratch cartridge already loaded in the drive; it is the library's responsibility to ensure
the cartridge may be written. Writing begins at beginning-of-tape. There is no concept of a logical
block here — data is simply pushed down to tape.

Data is sent from library to drive in sections. If an error occurs at any point, the drive sends a
`Maint_Status_Error` and the Write Tape message series is considered ended; a retry requires
re-issuing the entire series starting again from section number 0.

The drive returns a `Maint_Status_Good` each time roughly 4096 bytes have been sent within the same
series, as feedback that writes are progressing. A `Maint_Status_Good` is also sent after the very last
message in the series, which is the one with Section Flag `0x00`.

| Byte | Description |
|---|---|
| 0 | Msg Type (`0xAB`) |
| 1 | Tgt Addr |
| 2 … 5 | Msg ID |
| 6 | Msg Subtype (`0x30`) |
| 7 | Maintenance Sub-command (`0x66`) |
| 8 | Section Number |
| 9 | Section Flag |
| 10 (MSB) … 11 (LSB) | Section Size (= n − 11) |
| 12 … n | Section Data |

- **Section Number** — unsigned; must be 0 for the first section, incremented by one for each
  subsequent section. After `0xFF` it wraps to `0x00`.
- **Section Flag** — `0x00` for the last section, which flushes all buffered data and then rewinds;
  `0x80` for all other sections.
- **Section Size** — maximum 494.

### 8.11 Maint_Command — Read Log Sense Data (`0xB5`)

Requests SCSI Log Sense data. Does **not** clear any flags, including TapeAlert. Followed by 3
parameter bytes giving the log page to return and the maximum amount of log data to send in the
response. Granularity is at the Log page code level only — the parameter code cannot be specified. The
returned data format is exactly that of log parameter data for the SCSI command. For further detail,
see the applicable tape drive SCSI reference.

| Byte | Description |
|---|---|
| 0 | Msg Type (`0xAB`) |
| 1 | Tgt Addr |
| 2 … 5 | Msg ID |
| 6 | Msg Subtype (`0x30`) |
| 7 | Maintenance Sub-command (`0xB5`) |
| 8 | Page Code |
| 9 (MSB) … 10 (LSB) | Allocation Length |

### 8.12 Maint_Command — Set Traps (`0xC0`)

Followed by 2 bytes giving the Fault Symptom Code to trap on. Behaves the same as the SCSI Send
Diagnostic routine of the same name.

| Byte | Description |
|---|---|
| 0 | Msg Type (`0xAB`) |
| 1 | Tgt Addr |
| 2 … 5 | Msg ID |
| 6 | Msg Subtype (`0x30`) |
| 7 | Maintenance Sub-command (`0xC0`) |
| 8 (MSB) … 9 (LSB) | Fault Symptom Code |

### 8.13 Maint_Command — Remove Traps (`0xC1`)

Followed by 2 bytes giving the Fault Symptom Code to stop trapping on. Behaves the same as the SCSI
Send Diagnostic routine of the same name.

| Byte | Description |
|---|---|
| 0 | Msg Type (`0xAB`) |
| 1 | Tgt Addr |
| 2 … 5 | Msg ID |
| 6 | Msg Subtype (`0x30`) |
| 7 | Maintenance Sub-command (`0xC1`) |
| 8 (MSB) … 9 (LSB) | Fault Symptom Code |

### 8.14 Maint_Status_Good (Drive → Library, Type `0xAB`, Subtype `0x3C`)

Non-error response to a `Maint_Command`. The Msg ID field is copied from the originating
`Maint_Command`.

Data is returned only in response to these sub-commands: Read Standard Inquiry Data (`0x10`), Read
Request Sense Data (`0x11`), Read Device Identification Data (`0x12`), Read Buffer (`0x63`), Read Tape
(`0x65`), and Read Log Sense Data (`0xB5`).

**With no data**

| Byte | Description |
|---|---|
| 0 | Msg Type (`0xAB`) |
| 1 | Tgt Addr (`0xFF`) |
| 2 … 5 | Msg ID |
| 6 | Msg Subtype (`0x3C`) |
| 7 | Section Number (`0x00`) |
| 8 | Section Flag (`0x00`) |
| 9 (MSB) … 10 (LSB) | Section Size (`0x0000`) |

**With a single data section**

| Byte | Description |
|---|---|
| 0 | Msg Type (`0xAB`) |
| 1 | Tgt Addr (`0xFF`) |
| 2 … 5 | Msg ID |
| 6 | Msg Subtype (`0x3C`) |
| 7 | Section Number (`0x00`) |
| 8 | Section Flag (`0x00`) |
| 9 (MSB) … 10 (LSB) | Section Size (= n − 10) |
| 11 (MSB) … n (LSB) | Section Data |

**With multiple data sections**

If the returned data exceeds the packetable maximum it must be sent in multiple sections. This can
apply to Read Buffer (`0x63`), Read Tape (`0x65`), and Read Log Sense Data (`0xB5`). The data may be
broken into any convenient number of packets, and the packets are sent in order.

| Byte | Description |
|---|---|
| 0 | Msg Type (`0xAB`) |
| 1 | Tgt Addr (`0xFF`) |
| 2 … 5 | Msg ID |
| 6 | Msg Subtype (`0x3C`) |
| 7 | Section Number |
| 8 | Section Flag |
| 9 (MSB) … 10 (LSB) | Section Size (= n − 10) |
| 11 (MSB) … n (LSB) | Section Data |

- **Section Number** — section number of the current packet, starting at `0x00` and incrementing by 1;
  `0xFF` is followed by `0x00`.
- **Section Flag** — `0x00`: this is the last section. `0x80`: more sections follow. All other values
  reserved.

### 8.15 Maint_Status_Error (Drive → Library, Type `0xAB`, Subtype `0x3F`)

Error response to a `Maint_Command`. The Msg ID field is copied from the originating `Maint_Command`.
When error data is returned, it is in the format of SCSI Request Sense data.

| Byte | Description |
|---|---|
| 0 | Msg Type (`0xAB`) |
| 1 | Tgt Addr (`0xFF`) |
| 2 … 5 | Msg ID |
| 6 | Msg Subtype (`0x3F`) |
| 7 | Section Number (`0x00`) |
| 8 | Section Flag (`0x00`) |
| 9 (MSB) … 10 (LSB) | Error Data Size (= n − 10) |
| 11 (MSB) … n (LSB) | Error Data |

### 8.16 Drive_Status (Drive → Library, Type `0xAB`, Subtype `0x40`)

In non-polled mode (Configuration Flags bit 7 = 1), `Drive_Status` is sent asynchronously when:

- the drive receives a `Set_Config` and does not require a reset,
- any cartridge is loaded in the drive, or
- any cartridge is unloaded from the drive.

It is also sent in response to `Drive_Status_Request`.

> Any transmission of this message may or may not reflect a state change, so **library logic must not
> be edge- or transition-triggered.** The library should store this information in a per-drive buffer,
> or issue explicit `Drive_Status_Request` messages, as needed.

| Byte | Description |
|---|---|
| 0 | Msg Type (`0xAB`) |
| 1 | Tgt Addr (`0xFF`) |
| 2 … 5 | Msg ID |
| 6 | Msg Subtype (`0x40`) |
| 7 | Drive Status Flags 1 |
| 8 | Additional Status Length (`0x17`) |
| 9 | Display Character |
| 10 | Display Character Rate |
| 11 | Status LED |
| 12 | Status LED Rate |
| 13 | Tape Motion |
| 14 (MSB) … 21 (LSB) | Tape VolSer |
| 22 (MSB) … 29 (LSB) | TapeAlert Flags |
| 30 | Drive Status Flags 2 |
| 31 | Drive Status Flags 3 |

#### Drive Status Flags 1 (byte 7)

| Bit | Name | Values |
|---|---|---|
| 7 | Cartridge Not Loaded | 0 = a cartridge is loaded in the drive; 1 = no cartridge is loaded (a cartridge may still be present in the ejected/loadable position) |
| 6 | Drive Clean Required | 0 = drive does not need cleaning; 1 = drive needs cleaning |
| 5 | Reserved | |
| 4 | Write-Protected Cartridge | 0 = no cartridge loaded, or the loaded cartridge is not write protected; 1 = a write-protected cartridge is loaded |
| 3 | Compression Enabled | 0 = compression disabled; 1 = compression enabled |
| 2 | Cartridge Present | 0 = no cartridge present; 1 = a cartridge is present (may be in the ejected/loadable position) |
| 1 | Reserved | |
| 0 | LUN 0 Ready (Sequential Access Device) | 0 = LUN 0 is in a SCSI Not Ready condition; 1 = LUN 0 is in a SCSI Ready condition |

**Deriving cartridge position** from bits 7, 2, and 0:

| Bit 7 | Bit 2 | Bit 0 | Cartridge Position |
|---|---|---|---|
| 1 | 0 | 0 | Cartridge not present |
| 1 | 1 | 0 | Cartridge present in ejected/loadable position |
| 0 | 1 | 0 | Cartridge present in LTO-CM accessible position, but not threaded |
| 0 | 1 | 1 | Cartridge present, loaded, and threaded |

#### Display Character (byte 9)

ASCII field mirroring the single-character display on the front of the drive. Possible values include
`0`–`9`, `A`, `b`, `C`, `d`, `E`, and `H`. See the applicable drive product specification for detail.

#### Display Character Rate (byte 10)

Current flashing rate, in Hertz, of the single-character display.

| Value | Meaning |
|---|---|
| `0x00` | Off, blank |
| `0x01` | Blinking at 1 Hz |
| `0x02` | Blinking at 2 Hz |
| `0x04` | Blinking at 4 Hz |
| `0x7F` | On solid, no blinking |

#### Status LED (byte 11)

Mirrors the dual-color status LED on the front of the drive.

| Value | Meaning |
|---|---|
| 0 | Off |
| 1 | Green |
| 2 | Yellow |

#### Status LED Rate (byte 12)

Current flashing rate, in Hertz, of the dual-color status LED. Same encoding as Display Character Rate:
`0x00` off/blank, `0x01` 1 Hz, `0x02` 2 Hz, `0x04` 4 Hz, `0x7F` on solid.

#### Tape Motion (byte 13)

Decimal value indicating the current unique tape motion.

| Value | Meaning |
|---|---|
| 0 | No current motion |
| 1 | Writing |
| 2 | Reading |
| 3 | Erasing |
| 10 | Locating |
| 11 | Rewinding |
| 20 | Cleaning |
| 30 | Unloading |
| 32 | Loading |

#### Tape VolSer (bytes 14–21)

The Volume Serial Number recorded by host software on the tape media or in the CM of the currently
loaded cartridge, if the drive can detect it. Not to be confused with the cartridge serial number
stored in the CM by the cartridge manufacturer.

#### TapeAlert Flags (bytes 22–29)

Bit map of the current TapeAlert flag state, as it would be reported in response to a SCSI Log Sense
command. Byte 22 bit 7 is TapeAlert Flag 1; byte 29 bit 0 is TapeAlert Flag 64. Any flag already reset
by SCSI Log Sense is reported as reset here. **Reporting flags through this message does not reset
them.**

#### Drive Status Flags 2 (byte 30)

| Bit | Name | Values |
|---|---|---|
| 7 | Drive Communication Type | 0 = SCSI; 1 = Fibre Channel |
| 6 | Reserved | |
| 5 | Reserved | |
| 4 | Offline | 0 = online; 1 = offline |
| 3 | Hard AL_PA (Fibre Channel only) | 0 = soft AL_PA addressing, AL_PA determined by the drive during LIP processing; 1 = hard AL_PA addressing, AL_PA set using the LID provided by the library or hardware switch settings |
| 2 | AL_PA Conflict (Fibre Channel only) | 0 = no conflict; 1 = another device has the AL_PA, or no address is available |
| 1 | Light Detected (Fibre Channel only) | 0 = no light detected, cable disconnect is possible; 1 = light detected, cable is connected |
| 0 | Loop Initialized (Fibre Channel only) | 0 = Loop Initialization (LIP) is not complete; 1 = LIP is complete |

#### Drive Status Flags 3 (byte 31)

| Bit | Name | Values |
|---|---|---|
| 7 | POST Processing | 0 = POST processing is complete; 1 = POST is currently processing |
| 6–4 | Reserved | |
| 3–0 | Tape Cartridge Type | See below |

| Bits 3–0 | Tape Cartridge Type |
|---|---|
| `0000b` | No tape present, or cartridge not mounted successfully |
| `0001b` | Standard LTO Generation 1 format (per U18 spec.) |
| `0010b` | Cleaner cartridge |
| `0011b` | Drive FMR (firmware update) tape created via the Maintenance Panel |
| `0100b` | Drive FMR (firmware update) tape created via the Maint_Command Create Drive FMR Cartridge (`0x61`) |
| `0101b` | Reserved |
| `0110b` | Invalid cleaner cartridge |
| `0111b` | Invalid cartridge type |
| `1000b`–`1111b` | Reserved |

### 8.17 Drive_Status_Request (Library → Drive, Type `0xAB`, Subtype `0x41`)

Requests an explicit update of drive status; the drive responds with `Drive_Status`. Not normally
required. **This message is unique in that it may be sent even though another command is already in
progress.**

| Byte | Description |
|---|---|
| 0 | Msg Type (`0xAB`) |
| 1 | Tgt Addr |
| 2 … 5 | Msg ID |
| 6 | Msg Subtype (`0x41`) |

---

## 9. Interface Scenarios

After power-up or reset, the drive returns NAK for any `Two_Way` message from the library until the
handshaking startup process completes. This takes about five seconds.

### 9.1 Handshaking startup process — drive-initiated (non-polled default)

If the interface default is non-polled mode (set via drive feature switches), the drive starts the
handshake by sending `Config_Request`, expected within ten seconds of power-up. The library responds
with `Set_Config` carrying the current drive configuration. Depending on the current configuration and
the values received, the drive may need to reset itself; that takes about a minute.

| Step | Message | Direction | Purpose |
|---|---|---|---|
| 1 | `Config_Request` | Drive → Library | Request for library configuration (starts handshake) |
| 2 | `Set_Config` | Library → Drive | Library configuration information (completes handshake) |
| 3 | `Drive_Status` | Drive → Library | Initial drive status (if `Set_Config` selected non-polled mode) |

After `Set_Config`, the drive sends `Drive_Status` if it is not in the process of resetting and the
interface is in non-polled mode. If the drive is resetting, the entire process repeats for that drive,
beginning again with the drive sending `Config_Request`. Once the drive accepts `Set_Config`, that
drive is considered available and can accept `Two_Way` messages.

### 9.2 Handshaking startup process — library-initiated (polled default)

If the interface default is polled mode, the library is responsible for initiating the handshake. The
library may also optionally initiate it when it powers up, is reset, or detects an unexpected NAK from
the drive.

The library sends an asynchronous `Set_Config` with the current drive configuration. The drive may need
to reset itself (about a minute) depending on the current configuration and the values received.

| Step | Message | Direction | Purpose |
|---|---|---|---|
| 1 | `Set_Config` | Library → Drive | Library configuration information (completes handshake) |
| 2 | `Drive_Status` | Drive → Library | Initial drive status (if `Set_Config` selected non-polled mode) |

After `Set_Config`, the drive sends `Drive_Status` if it is not resetting and the interface is in
non-polled mode. **In polled mode**, the library discovers that `Set_Config` is done and the drive is
ready for normal operation by issuing a `Drive_Status_Request`: if Drive Status Flags 3 (byte 31) bit 7,
POST Processing, returns 0, the drive is ready. If the drive is in the process of resetting, the
handshaking startup process is repeated once for that drive. Once the drive accepts `Set_Config`, that
drive is considered available and can accept `Two_Way` messages.

### 9.3 Set_Config fields that cause a drive reboot

Applies to both scenarios above.

| Field | Reboot |
|---|---|
| LDI Address (Tgt Addr) | N |
| Drive FC/SCSI Address | Y (N if within 10 seconds of power-on reset) |
| Drive Fibre Channel World Wide Node Name | Y |
| Configuration Flags bit 3, Disable automatic drive online | Y |

> **Compatibility note.** All drive firmware levels accept bytes 0–53 of `Set_Config`. One way to avoid
> problems is to always start with a `Set_Config` of just those first 54 bytes. Additional `Set_Config`
> commands can then be sent depending on `Drive_Status` (for example, indicating the drive is a Fibre
> Channel drive) and on which additional fields the library needs to set.
