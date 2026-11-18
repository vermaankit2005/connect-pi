import assert from "node:assert/strict";
import test from "node:test";
import { projectGroups, projectKey } from "./projects.js";

test("projects normalize Windows folders and keep different full paths separate", () => {
	assert.equal(projectKey("D:\\Work\\App\\"), projectKey("d:/work/app"));
	const groups = projectGroups([], [
		{ id: "a", cwd: "D:\\Work\\App", cwdName: "App", updatedAt: 10 },
		{ id: "b", cwd: "D:\\Personal\\App", cwdName: "App", updatedAt: 20 },
		{ id: "c", cwd: "d:/work/app/", cwdName: "App", updatedAt: 30 },
	]);
	assert.equal(groups.length, 2);
	assert.deepEqual(groups[0].chats.map((c) => c.session.id), ["c", "a"]);
});

test("a running conversation replaces its saved entry without hiding other history", () => {
	const groups = projectGroups([
		{ id: "live", piSessionId: "saved", cwd: "D:/App", connectedAt: 40 },
	], [
		{ id: "saved", cwd: "D:/App", updatedAt: 50 },
		{ id: "earlier", cwd: "D:/App", updatedAt: 20 },
	]);
	assert.deepEqual(groups[0].chats.map((c) => [c.kind, c.session.id]), [["live", "live"], ["past", "earlier"]]);
	assert.deepEqual(projectGroups([], []), []);
});
