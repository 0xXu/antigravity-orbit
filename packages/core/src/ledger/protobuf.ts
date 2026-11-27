/**
 * Clean-room zero-dependency Protobuf wire-format decoder & field projector.
 * Safely decodes varint (0), fixed64 (1), length-delimited (2), and fixed32 (5)
 * without requiring external .proto schemas or runtime npm packages.
 */

export interface WireField {
  readonly fieldNumber: number;
  readonly wireType: 0 | 1 | 2 | 5;
  readonly value: bigint | Uint8Array;
}

export function decodeWireFields(buf: Uint8Array, maxFields = 10_000): WireField[] {
  const fields: WireField[] = [];
  let offset = 0;

  while (offset < buf.length && fields.length < maxFields) {
    const tagRes = readVarint(buf, offset);
    if (!tagRes) break;
    offset = tagRes.nextOffset;

    const fieldNumber = Number(tagRes.value >> 3n);
    const wireType = Number(tagRes.value & 7n);
    if (fieldNumber <= 0) break;

    if (wireType === 0) {
      const val = readVarint(buf, offset);
      if (!val) break;
      offset = val.nextOffset;
      fields.push({ fieldNumber, wireType: 0, value: val.value });
    } else if (wireType === 1) {
      if (offset + 8 > buf.length) break;
      const view = new DataView(buf.buffer, buf.byteOffset + offset, 8);
      fields.push({ fieldNumber, wireType: 1, value: view.getBigUint64(0, true) });
      offset += 8;
    } else if (wireType === 2) {
      const lenRes = readVarint(buf, offset);
      if (!lenRes) break;
      const len = Number(lenRes.value);
      offset = lenRes.nextOffset;
      if (len < 0 || offset + len > buf.length) break;
      fields.push({ fieldNumber, wireType: 2, value: buf.subarray(offset, offset + len) });
      offset += len;
    } else if (wireType === 5) {
      if (offset + 4 > buf.length) break;
      const view = new DataView(buf.buffer, buf.byteOffset + offset, 4);
      fields.push({ fieldNumber, wireType: 5, value: BigInt(view.getUint32(0, true)) });
      offset += 4;
    } else {
      // Unsupported/deprecated group wire type — fail closed
      break;
    }
  }

  return fields;
}

function readVarint(buf: Uint8Array, start: number): { value: bigint; nextOffset: number } | null {
  let result = 0n;
  let shift = 0n;
  let offset = start;

  while (offset < buf.length && shift < 70n) {
    const byte = buf[offset++]!;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result, nextOffset: offset };
    }
    shift += 7n;
  }
  return null;
}

export function projectUintField(fields: readonly WireField[], fieldNumber: number): number {
  for (const f of fields) {
    if (f.fieldNumber === fieldNumber && (f.wireType === 0 || f.wireType === 1 || f.wireType === 5)) {
      return Number(f.value);
    }
  }
  return 0;
}

export function projectStringField(fields: readonly WireField[], fieldNumber: number): string {
  for (const f of fields) {
    if (f.fieldNumber === fieldNumber && f.wireType === 2 && f.value instanceof Uint8Array) {
      return new TextDecoder().decode(f.value);
    }
  }
  return '';
}

export function projectBytesField(fields: readonly WireField[], fieldNumber: number): Uint8Array | null {
  for (const f of fields) {
    if (f.fieldNumber === fieldNumber && f.wireType === 2 && f.value instanceof Uint8Array) {
      return f.value;
    }
  }
  return null;
}
