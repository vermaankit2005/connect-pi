// The desktop icon: the same violet pi tile as the phone app, so the shortcut
// on the desktop and the icon on the phone are obviously the same thing.
//
//   npm run icons:desktop
//
// Written as .ico with several sizes inside, because Windows picks a different
// one for the desktop, the taskbar and the alt-tab list.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeIco, encodePng } from "./png.mjs";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "icons");
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SS = 4; // supersampling, for smooth edges

function roundedRect(x, y, w, h, r) {
	return (px, py) => {
		if (px < x || py < y || px > x + w || py > y + h) return false;
		const cx = Math.min(Math.max(px, x + r), x + w - r);
		const cy = Math.min(Math.max(py, y + r), y + h - r);
		return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
	};
}

/**
 * @param size    pixel size of the finished icon
 * @param from/to the two ends of the diagonal background gradient, as [r,g,b]
 * @param glyph   (S) => hit-test function for the white shape on top
 */
function draw(size, { from, to, glyph }) {
	const S = size * SS;
	const big = Buffer.alloc(S * S * 4);
	const bg = roundedRect(0, 0, S, S, S * 0.22);
	const mark = glyph(S);

	for (let y = 0; y < S; y++) {
		for (let x = 0; x < S; x++) {
			if (!bg(x, y)) continue;
			const i = (y * S + x) * 4;
			const t = (x / S) * 0.55 + (y / S) * 0.45;
			big[i] = Math.round(from[0] + (to[0] - from[0]) * t);
			big[i + 1] = Math.round(from[1] + (to[1] - from[1]) * t);
			big[i + 2] = Math.round(from[2] + (to[2] - from[2]) * t);
			big[i + 3] = 255;
			if (mark(x, y)) {
				big[i] = 255;
				big[i + 1] = 255;
				big[i + 2] = 255;
			}
		}
	}

	// downsample, keeping the colour of transparent pixels out of the average
	const out = Buffer.alloc(size * size * 4);
	const n = SS * SS;
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			for (let dy = 0; dy < SS; dy++) {
				for (let dx = 0; dx < SS; dx++) {
					const i = ((y * SS + dy) * S + (x * SS + dx)) * 4;
					const al = big[i + 3] / 255;
					r += big[i] * al;
					g += big[i + 1] * al;
					b += big[i + 2] * al;
					a += big[i + 3];
				}
			}
			const alpha = a / n;
			const norm = alpha > 0 ? 255 / alpha : 0;
			const o = (y * size + x) * 4;
			out[o] = Math.min(255, Math.round((r / n) * norm));
			out[o + 1] = Math.min(255, Math.round((g / n) * norm));
			out[o + 2] = Math.min(255, Math.round((b / n) * norm));
			out[o + 3] = Math.round(alpha);
		}
	}
	return encodePng(size, size, out);
}

// The pi glyph: a bar with two legs, the same shape make-icons.mjs draws for the
// phone. Kept in step by eye, not by import, because that file writes PNGs the
// moment it is loaded.
function piGlyph(S) {
	const barY = S * 0.3;
	const barH = S * 0.085;
	const bar = roundedRect(S * 0.17, barY, S * 0.66, barH, barH / 2);
	const legW = S * 0.085;
	const legTop = barY + barH * 0.6;
	const legBot = S * 0.76;
	const legL = roundedRect(S * 0.3, legTop, legW, legBot - legTop, legW / 3);
	const legR = roundedRect(S * 0.615, legTop, legW, legBot - legTop, legW / 3);
	return (x, y) => bar(x, y) || legL(x, y) || legR(x, y);
}

const PI = {
	from: [124, 108, 255],
	to: [78, 62, 214],
	glyph: piGlyph,
};

const ico = (spec) => encodeIco(SIZES.map((size) => ({ size, png: draw(size, spec) })));

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "pi.ico"), ico(PI));
console.log("desktop icon written to scripts/icons/pi.ico");
