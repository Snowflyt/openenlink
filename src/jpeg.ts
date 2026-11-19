// Baseline JPEG decoder (ITU-T T.81 sequential DCT with Huffman coding, 8-bit samples), enough to
// draw a school's captcha in the terminal. Progressive, lossless, arithmetic-coded, 12-bit and
// CMYK images throw.

export type Bitmap = { width: number; height: number; rgb: Uint8ClampedArray };

type Huffman = { maxcode: Int32Array; mincode: Int32Array; valptr: Int32Array; values: Uint8Array };

type Component = {
  id: number;
  h: number;
  v: number;
  quant: number;
  blocksPerLine: number;
  samples: Uint8ClampedArray;
};

type Frame = {
  width: number;
  height: number;
  hmax: number;
  vmax: number;
  mcusPerLine: number;
  mcusPerColumn: number;
  components: Component[];
};

// A scan may name a table slot that no segment defined.
type Tables = {
  quant: (Int32Array | undefined)[];
  dc: (Huffman | undefined)[];
  ac: (Huffman | undefined)[];
  restart: number;
};

// Natural (row-major) position of each coefficient in zigzag order.
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
  13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52,
  45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

// COSINES[x * 8 + u] = C(u) cos((2x + 1) u π / 16) / 2, one factor of the 2-D inverse DCT.
const COSINES = Float64Array.from({ length: 64 }, (_, index) => {
  const x = Math.floor(index / 8);
  const u = index % 8;
  return ((u === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * x + 1) * u * Math.PI) / 16)) / 2;
});

const damaged = () => new Error("Damaged JPEG image");

export function decodeJpeg(bytes: Uint8Array): Bitmap {
  const u16 = (at: number) => (bytes[at] << 8) | bytes[at + 1];
  if (bytes.length < 4 || u16(0) !== 0xffd8) throw new Error("Not a JPEG image");
  const tables: Tables = { quant: [], dc: [], ac: [], restart: 0 };
  let frame: Frame | undefined;
  let scanned = false;
  let adobeTransform: number | undefined;
  let pos = 2;
  while (pos < bytes.length) {
    if (bytes[pos] !== 0xff) throw damaged();
    while (bytes[pos] === 0xff) pos++;
    const marker = bytes[pos++];
    if (marker === 0xd9) break;
    if (pos + 2 > bytes.length) throw damaged();
    const length = u16(pos);
    if (length < 2 || pos + length > bytes.length) throw damaged();
    const segment = bytes.subarray(pos + 2, pos + length);
    pos += length;
    if (marker === 0xdb) readQuantization(segment, tables);
    else if (marker === 0xc4) readHuffman(segment, tables);
    else if (marker === 0xc0 || marker === 0xc1) frame = readFrame(segment);
    else if (marker === 0xdd) tables.restart = (segment[0] << 8) | segment[1];
    else if (marker === 0xee && new TextDecoder().decode(segment.subarray(0, 5)) === "Adobe")
      adobeTransform = segment[11];
    else if (marker === 0xda) {
      if (!frame) throw damaged();
      pos = readScan(bytes, pos, segment, frame, tables);
      scanned = true;
    } else if (marker >= 0xc2 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xcc)
      throw new Error("Only baseline JPEG images are supported");
  }
  if (!frame || !scanned) throw damaged();
  return toRgb(frame, adobeTransform);
}

function readQuantization(segment: Uint8Array, tables: Tables): void {
  for (let at = 0; at < segment.length;) {
    const wide = segment[at] >> 4;
    const id = segment[at++] & 15;
    const table = new Int32Array(64);
    for (let k = 0; k < 64; k++) {
      table[ZIGZAG[k]] = wide ? (segment[at] << 8) | segment[at + 1] : segment[at];
      at += wide ? 2 : 1;
    }
    if (at > segment.length) throw damaged();
    tables.quant[id] = table;
  }
}

// Decoding tables of ITU-T T.81 annex F.2.2.3.
function readHuffman(segment: Uint8Array, tables: Tables): void {
  for (let at = 0; at < segment.length;) {
    const kind = segment[at] >> 4;
    const id = segment[at] & 15;
    const counts = segment.subarray(at + 1, at + 17);
    const total = counts.reduce((sum, count) => sum + count, 0);
    const values = segment.subarray(at + 17, at + 17 + total);
    if (counts.length < 16 || values.length < total) throw damaged();
    const table = {
      maxcode: new Int32Array(17).fill(-1),
      mincode: new Int32Array(17),
      valptr: new Int32Array(17),
      values,
    };
    let code = 0;
    let index = 0;
    for (let length = 1; length <= 16; length++) {
      const count = counts[length - 1];
      table.valptr[length] = index;
      table.mincode[length] = code;
      code += count;
      index += count;
      if (count) table.maxcode[length] = code - 1;
      code <<= 1;
    }
    (kind === 0 ? tables.dc : tables.ac)[id] = table;
    at += 17 + total;
  }
}

function readFrame(segment: Uint8Array): Frame {
  if (segment[0] !== 8) throw new Error("Only 8-bit JPEG images are supported");
  const height = (segment[1] << 8) | segment[2];
  const width = (segment[3] << 8) | segment[4];
  const count = segment[5];
  if (!width || !height || segment.length < 6 + count * 3) throw damaged();
  if (count !== 1 && count !== 3)
    throw new Error("Only grayscale and color JPEG images are supported");
  const specs = Array.from({ length: count }, (_, index) => ({
    id: segment[6 + index * 3],
    h: segment[7 + index * 3] >> 4,
    v: segment[7 + index * 3] & 15,
    quant: segment[8 + index * 3],
  }));
  if (specs.some(({ h, v }) => h < 1 || h > 4 || v < 1 || v > 4)) throw damaged();
  const hmax = Math.max(...specs.map(({ h }) => h));
  const vmax = Math.max(...specs.map(({ v }) => v));
  const mcusPerLine = Math.ceil(width / (8 * hmax));
  const mcusPerColumn = Math.ceil(height / (8 * vmax));
  return {
    width,
    height,
    hmax,
    vmax,
    mcusPerLine,
    mcusPerColumn,
    components: specs.map((spec) => ({
      ...spec,
      blocksPerLine: mcusPerLine * spec.h,
      samples: new Uint8ClampedArray(mcusPerLine * spec.h * 8 * mcusPerColumn * spec.v * 8),
    })),
  };
}

// Decodes the entropy-coded data after a scan header and returns the offset of the next marker.
function readScan(
  bytes: Uint8Array,
  start: number,
  header: Uint8Array,
  frame: Frame,
  tables: Tables,
): number {
  const scan = Array.from({ length: header[0] }, (_, index) => {
    const component = frame.components.find(({ id }) => id === header[1 + index * 2]);
    const selectors = header[2 + index * 2];
    const dc = tables.dc[selectors >> 4];
    const ac = tables.ac[selectors & 15];
    const quant = component && tables.quant[component.quant];
    if (!component || !dc || !ac || !quant) throw damaged();
    return { component, dc, ac, quant, prediction: 0 };
  });
  if (!scan.length) throw damaged();

  let pos = start;
  let buffer = 0;
  let bits = 0;
  const bit = (): number => {
    if (bits === 0) {
      buffer = 0;
      if (bytes[pos] === 0xff) {
        // 0xFF 0x00 is a stuffed 0xFF; any other marker ends the data, which then reads as zeros.
        if (bytes[pos + 1] === 0) {
          buffer = 0xff;
          pos += 2;
        }
      } else if (pos < bytes.length) buffer = bytes[pos++];
      bits = 8;
    }
    bits--;
    return (buffer >> bits) & 1;
  };
  const receive = (length: number): number => {
    let value = 0;
    for (let index = 0; index < length; index++) value = (value << 1) | bit();
    return value;
  };
  const extend = (value: number, length: number) =>
    value < 1 << (length - 1) ? value - (1 << length) + 1 : value;
  const decode = (table: Huffman): number => {
    let code = bit();
    let length = 1;
    while (code > table.maxcode[length]) {
      if (++length > 16) throw damaged();
      code = (code << 1) | bit();
    }
    const at = table.valptr[length] + code - table.mincode[length];
    if (at >= table.values.length) throw damaged();
    return table.values[at];
  };

  const coefficients = new Float64Array(64);
  const rows = new Float64Array(64);
  const block = (entry: (typeof scan)[number], row: number, column: number) => {
    coefficients.fill(0);
    const size = decode(entry.dc);
    entry.prediction += size ? extend(receive(size), size) : 0;
    coefficients[0] = entry.prediction * entry.quant[0];
    for (let k = 1; k < 64;) {
      const symbol = decode(entry.ac);
      const zeros = symbol >> 4;
      const size = symbol & 15;
      if (!size) {
        if (zeros !== 15) break;
        k += 16;
        continue;
      }
      k += zeros;
      if (k > 63) throw damaged();
      const index = ZIGZAG[k++];
      coefficients[index] = extend(receive(size), size) * entry.quant[index];
    }
    const stride = entry.component.blocksPerLine * 8;
    inverseDct(coefficients, rows, entry.component.samples, row * 8 * stride + column * 8, stride);
  };

  // A scan of one component visits its blocks in raster order; an interleaved scan visits
  // minimum coded units of h × v blocks per component.
  const single = scan.length === 1 ? scan[0].component : undefined;
  const blocksPerLine =
    single ? Math.ceil(Math.ceil((frame.width * single.h) / frame.hmax) / 8) : 0;
  const units =
    single ?
      blocksPerLine * Math.ceil(Math.ceil((frame.height * single.v) / frame.vmax) / 8)
    : frame.mcusPerLine * frame.mcusPerColumn;
  for (let unit = 0; unit < units; unit++) {
    if (tables.restart && unit && unit % tables.restart === 0) {
      bits = 0;
      while (pos < bytes.length && !(bytes[pos] === 0xff && isRestart(bytes[pos + 1]))) pos++;
      if (pos >= bytes.length) throw damaged();
      pos += 2;
      for (const entry of scan) entry.prediction = 0;
    }
    if (single) block(scan[0], Math.floor(unit / blocksPerLine), unit % blocksPerLine);
    else {
      const row = Math.floor(unit / frame.mcusPerLine);
      const column = unit % frame.mcusPerLine;
      for (const entry of scan)
        for (let v = 0; v < entry.component.v; v++)
          for (let h = 0; h < entry.component.h; h++)
            block(entry, row * entry.component.v + v, column * entry.component.h + h);
    }
  }
  while (
    pos < bytes.length &&
    !(bytes[pos] === 0xff && bytes[pos + 1] !== 0 && !isRestart(bytes[pos + 1]))
  )
    pos++;
  return pos;
}

function isRestart(marker: number): boolean {
  return marker >= 0xd0 && marker <= 0xd7;
}

// Separable 8 × 8 inverse DCT, rows first, then columns, level-shifted by 128.
function inverseDct(
  coefficients: Float64Array,
  rows: Float64Array,
  output: Uint8ClampedArray,
  offset: number,
  stride: number,
): void {
  for (let v = 0; v < 8; v++)
    for (let x = 0; x < 8; x++) {
      let sum = 0;
      for (let u = 0; u < 8; u++) sum += COSINES[x * 8 + u] * coefficients[v * 8 + u];
      rows[v * 8 + x] = sum;
    }
  for (let x = 0; x < 8; x++)
    for (let y = 0; y < 8; y++) {
      let sum = 0;
      for (let v = 0; v < 8; v++) sum += COSINES[y * 8 + v] * rows[v * 8 + x];
      output[offset + y * stride + x] = Math.round(sum + 128);
    }
}

// Subsampled components are stretched by repeating samples. Three components are YCbCr unless
// an Adobe marker says they are already RGB.
function toRgb(frame: Frame, adobeTransform: number | undefined): Bitmap {
  const { components, height, hmax, vmax, width } = frame;
  const rgb = new Uint8ClampedArray(width * height * 3);
  const sample = (component: Component, x: number, y: number) =>
    component.samples[
      Math.floor((y * component.v) / vmax) * component.blocksPerLine * 8 +
        Math.floor((x * component.h) / hmax)
    ];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3;
      const [first, second, third] = components.map((component) => sample(component, x, y));
      if (components.length === 1) rgb.fill(first, at, at + 3);
      else if (adobeTransform === 0) rgb.set([first, second, third], at);
      else {
        const cb = second - 128;
        const cr = third - 128;
        rgb[at] = Math.round(first + 1.402 * cr);
        rgb[at + 1] = Math.round(first - 0.344_136 * cb - 0.714_136 * cr);
        rgb[at + 2] = Math.round(first + 1.772 * cb);
      }
    }
  return { width, height, rgb };
}
