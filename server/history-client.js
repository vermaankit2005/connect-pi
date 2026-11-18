import { Worker } from "node:worker_threads";

let worker;
let sequence = 0;
const pending = new Map();

function startWorker() {
	const instance = new Worker(new URL("./history-worker.js", import.meta.url));
	instance.on("message", ({ id, result, error }) => {
		const call = pending.get(id);
		if (!call) return;
		pending.delete(id);
		if (!pending.size) instance.unref();
		if (error) call.reject(new Error(error));
		else call.resolve(result);
	});
	instance.on("exit", () => {
		worker = undefined;
		for (const call of pending.values()) call.reject(new Error("Could not read saved Pi conversations."));
		pending.clear();
	});
	instance.on("error", () => {}); // the exit handler settles all pending work
	return instance;
}

export function historyJob(action, options) {
	if (pending.size >= 32) return Promise.reject(new Error("History is busy. Try again in a moment."));
	worker ||= startWorker();
	worker.ref();
	const id = ++sequence;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		worker.postMessage({ id, action, options });
	});
}
