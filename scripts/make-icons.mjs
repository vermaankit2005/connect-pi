// Generates the phone app icons with no image libraries: draw into a pixel
// buffer, supersample for smooth edges, encode PNG by hand (see png.mjs).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodePng } from "./png.mjs";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "icons");

// --- drawing ----------------------------------------------------------

const SS = 4; // supersampling factor

function roundedRect(x, y, w, h, r) {
	return (px, py) => {
		if (px < x || py < y || px > x + w || py > y + h) return false;
		const cx = Math.min(Math.max(px, x + r), x + w - r);
		const cy = Math.min(Math.max(py, y + r), y + h - r);
		return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
	};
}

function drawIcon(size, { inset = 0, radiusFactor = 0.22 } = {}) {
	const S = size * SS;
	const big = Buffer.alloc(S * S * 4);

	const pad = inset * S;
	const boxR = inset > 0 ? S / 2 : S * radiusFactor; // maskable = full bleed circle-safe
	const bg = inset > 0 ? roundedRect(0, 0, S, S, 0.0001) : roundedRect(0, 0, S, S, boxR);

	// glyph geometry, expressed inside the padded content box
	const c = { x: pad, y: pad, s: S - pad * 2 };
	const barY = c.y + c.s * 0.3;
	const barH = c.s * 0.085;
	const bar = roundedRect(c.x + c.s * 0.17, barY, c.s * 0.66, barH, barH / 2);
	const legW = c.s * 0.085;
	const legTop = barY + barH * 0.6;
	const legBot = c.y + c.s * 0.76;
	const legL = roundedRect(c.x + c.s * 0.3, legTop, legW, legBot - legTop, legW / 3);
	const legR = roundedRect(c.x + c.s * 0.615, legTop, legW, legBot - legTop, legW / 3);

	for (let y = 0; y < S; y++) {
		for (let x = 0; x < S; x++) {
			const i = (y * S + x) * 4;
			if (!bg(x, y)) continue;
			// diagonal violet gradient
			const t = (x / S) * 0.55 + (y / S) * 0.45;
			big[i] = Math.round(124 - t * 46);
			big[i + 1] = Math.round(108 - t * 46);
			big[i + 2] = Math.round(255 - t * 41);
			big[i + 3] = 255;
			if (bar(x, y) || legL(x, y) || legR(x, y)) {
				big[i] = 255;
				big[i + 1] = 255;
				big[i + 2] = 255;
			}
		}
	}

	// downsample
	const out = Buffer.alloc(size * size * 4);
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
			const n = SS * SS;
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

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "icon-192.png"), drawIcon(192));
writeFileSync(join(OUT, "icon-512.png"), drawIcon(512));
writeFileSync(join(OUT, "icon-maskable-512.png"), drawIcon(512, { inset: 0.14 }));
console.log("icons written to web/icons/");
