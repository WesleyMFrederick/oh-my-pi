// Fixture process for cross-process ledger tests. Commands arrive as argv, handshakes on stdin/stdout:
//   own <dir> <browserPid>      record <browserPid> with this process as owner, print "ready", wait for "go",
//                               release with kill, print the outcome as JSON.
//   borrow <dir> <browserPid>   print "ready", wait for "go", borrow, print the role as JSON, then stay alive
//                               (as a live borrower) until stdin closes.
//   release-twice <dir> <browserPid>
//                               record as owner, release with kill twice concurrently, print outcomes and the
//                               success lifecycle records emitted.
import { spyOn } from "bun:test";
import { logger } from "@oh-my-pi/pi-utils";
import {
	addLaunchedBrowserBorrower,
	processStartTime,
	recordLaunchedBrowser,
	releaseLaunchedBrowser,
} from "../../../src/tools/browser/launch-ledger";

const [mode, dir, pidArg] = process.argv.slice(2);
const browserPid = Number(pidArg);
const opts = { dir };

const decoder = new TextDecoder();
const reader = Bun.stdin.stream().getReader();
let pending = "";
async function nextLine(): Promise<string | undefined> {
	for (;;) {
		const newline = pending.indexOf("\n");
		if (newline >= 0) {
			const line = pending.slice(0, newline);
			pending = pending.slice(newline + 1);
			return line;
		}
		const chunk = await reader.read();
		if (chunk.done) return undefined;
		pending += decoder.decode(chunk.value);
	}
}

function emit(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

const ownerRecord = { browserPid, exe: "fixture", cdpPort: 0, headless: true, ownerSessionId: "worker" };

if (mode === "own") {
	await recordLaunchedBrowser(ownerRecord, opts);
	emit("ready");
	await nextLine();
	emit(await releaseLaunchedBrowser(browserPid, { kill: true, reason: "race" }, opts));
} else if (mode === "borrow") {
	await processStartTime(process.pid);
	emit("ready");
	await nextLine();
	emit(await addLaunchedBrowserBorrower(browserPid, opts));
	while ((await nextLine()) !== undefined) {
		// Stay alive as a borrower until the parent closes stdin.
	}
} else if (mode === "release-twice") {
	await recordLaunchedBrowser(ownerRecord, opts);
	const info = spyOn(logger, "info");
	const outcomes = await Promise.all([
		releaseLaunchedBrowser(browserPid, { kill: true, reason: "first" }, opts),
		releaseLaunchedBrowser(browserPid, { kill: true, reason: "second" }, opts),
	]);
	const releaseRecords = info.mock.calls.filter(
		([message, fields]) =>
			message === "browser.lifecycle" &&
			typeof fields === "object" &&
			fields !== null &&
			"action" in fields &&
			fields.action === "release",
	).length;
	emit({ outcomes, releaseRecords });
} else {
	throw new Error(`unknown mode ${mode}`);
}
process.exit(0);
