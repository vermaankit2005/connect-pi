import { handlePhoneCommand, runForeground } from "../server/phone-control.js";

try {
	const args = process.argv.slice(2).join(" ");
	if (args === "foreground") await runForeground();
	else await handlePhoneCommand(args, { hasUI: false, cwd: process.cwd(), ui: { notify: console.log } });
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}
