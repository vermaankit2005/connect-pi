import { handlePhoneCommand } from "../server/phone-control.js";

try {
	await handlePhoneCommand(process.argv.slice(2).join(" ") || "status", {
		hasUI: false, cwd: process.cwd(), ui: { notify: (message) => console.log(message) },
	});
} catch (error) { console.error(error.message); process.exitCode = 1; }
