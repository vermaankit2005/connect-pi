// Folder browsing for the phone's "start a session here" picker.
//
// Everything is clamped to the configured roots. Paths are resolved to their
// real location before checking, so ".." and symlinks cannot walk out.

import { mkdir, readdir, stat } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

const HIDDEN = new Set([
	"node_modules",
	".git",
	".venv",
	"venv",
	"__pycache__",
	"dist",
	"build",
	".next",
	"target",
	// Windows keeps these at the top of every drive. Now that a whole drive can
	// be a root, they would otherwise be the first thing you see.
	"$recycle.bin",
	"system volume information",
	"recovery",
	"found.000",
]);

/** "D:\\" has no basename, so fall back to the path itself. */
const prettyName = (p) => basename(p) || p;

function within(child, parent) {
	const rel = relative(parent, child);
	return !rel || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

/** Only existing directories under an existing, canonical root are accepted. */
export async function resolveInsideRoots(requested, roots) {
	if (typeof requested !== "string" || !isAbsolute(requested)) return null;
	try {
		const real = await realpath(requested);
		if (!(await stat(real)).isDirectory()) return null;
		for (const root of roots) {
			const realRoot = await realpath(root).catch(() => null);
			if (realRoot && within(real, realRoot)) return real;
		}
	} catch {}
	return null;
}

/** The top level of the picker: one entry per configured root. */
export async function listRoots(roots) {
	const out = [];
	for (const root of roots) {
		const p = resolve(root);
		let exists = false;
		try {
			exists = (await stat(p)).isDirectory();
		} catch {
			exists = false;
		}
		out.push({ path: p, name: prettyName(p), exists });
	}
	return out;
}

/** Subfolders of `dir`, plus whether each looks like a code project. */
export async function listFolders(dir, roots) {
	const real = await resolveInsideRoots(dir, roots);
	if (!real) throw new Error("That folder is outside the allowed list.");

	const entries = await readdir(real, { withFileTypes: true });
	const folders = [];
	for (const e of entries) {
		if (!e.isDirectory()) continue;
		if (e.name.startsWith(".") || HIDDEN.has(e.name.toLowerCase())) continue;
		const full = join(real, e.name);
		let modified = 0;
		try {
			modified = (await stat(full)).mtimeMs;
		} catch {}
		folders.push({ path: full, name: e.name, modified });
	}
	folders.sort((a, b) => b.modified - a.modified);

	// so the phone can offer "start here" on the folder you are looking at.
	// resolve("D:\\", "..") comes back as "D:\\" itself, so guard against an
	// "up one level" row at the top of a drive that would go nowhere.
	const parent = resolve(real, "..");
	const atDriveRoot = parent.toLowerCase() === real.toLowerCase();
	const parentAllowed = !atDriveRoot && Boolean(await resolveInsideRoots(parent, roots));

	return { path: real, name: prettyName(real), parent: parentAllowed ? parent : null, folders };
}

/** Create a new folder for a fresh project, inside the allowed roots. */
export async function createFolder(parentDir, name, roots) {
	const clean = typeof name === "string" ? name.trim() : "";
	if (!clean) throw new Error("Give the folder a name.");
	if (/[\\/:*?"<>|]/.test(clean)) throw new Error('A folder name cannot contain \\ / : * ? " < > |');
	if (clean.endsWith(".") || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean) || clean.length > 120) throw new Error("That is not a valid name.");

	const realParent = await resolveInsideRoots(parentDir, roots);
	if (!realParent) throw new Error("That folder is outside the allowed list.");

	const target = join(realParent, clean);

	await mkdir(target, { recursive: false });
	return target;
}
