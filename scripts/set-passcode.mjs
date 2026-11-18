import { createInterface } from "node:readline/promises";
import { rotatePasscode } from "../server/phone-control.js";

const rl = createInterface({ input: process.stdin, output: process.stdout });
try {
	const passcode = (await rl.question("Choose a new 6-digit phone passcode: ")).trim();
	if (passcode !== (await rl.question("Enter it again: ")).trim()) throw new Error("Passcodes did not match.");
	await rotatePasscode(passcode);
	console.log("Passcode changed. Phones must unlock again.");
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
} finally {
	rl.close();
}
