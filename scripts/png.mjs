// A PNG encoder in about fifty lines, so no icon here needs an image library.
//
// Used by make-icons.mjs (the phone app icons) and make-desktop-icons.mjs (the
// two Windows shortcuts on the desktop).

import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
	const t = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c;
	}
	return t;
})();

function crc32(buf) {
	let c = -1;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ -1) >>> 0;
}

function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([len, body, crc]);
}

/** RGBA pixel buffer to PNG bytes. */
export function encodePng(width, height, rgba) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // truecolour + alpha
	const raw = Buffer.alloc((width * 4 + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (width * 4 + 1)] = 0; // filter: none
		rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/**
 * Wrap PNGs into a Windows .ico. Vista and later read PNG-compressed entries
 * directly, so each size goes in as the PNG it already is.
 *
 * @param {{ size: number, png: Buffer }[]} images  smallest first is fine
 */
export function encodeIco(images) {
	const header = Buffer.alloc(6);
	header.writeUInt16LE(0, 0); // reserved
	header.writeUInt16LE(1, 2); // 1 = icon
	header.writeUInt16LE(images.length, 4);

	const dir = Buffer.alloc(16 * images.length);
	let offset = header.length + dir.length;

	images.forEach((img, i) => {
		const at = i * 16;
		dir[at] = img.size >= 256 ? 0 : img.size; // 0 means 256
		dir[at + 1] = img.size >= 256 ? 0 : img.size;
		dir[at + 2] = 0; // palette size
		dir[at + 3] = 0; // reserved
		dir.writeUInt16LE(1, at + 4); // colour planes
		dir.writeUInt16LE(32, at + 6); // bits per pixel
		dir.writeUInt32LE(img.png.length, at + 8);
		dir.writeUInt32LE(offset, at + 12);
		offset += img.png.length;
	});

	return Buffer.concat([header, dir, ...images.map((i) => i.png)]);
}
