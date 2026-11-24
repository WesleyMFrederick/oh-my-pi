import { spyOn } from "bun:test";
import * as os from "node:os";
import * as browsers from "@oh-my-pi/pi-utils/browsers";
import {
	chromiumNeedsDownload,
	ensureChromiumExecutable,
	ensureSignInChromiumExecutable,
} from "@oh-my-pi/pi-coding-agent/tools/browser/launch";

// Launch policy reads `process.platform`; Chrome-for-Testing platform detection reads `os.platform()`, which Bun does
// not derive from the `process.platform` override. Pin both so the child resolves the emulated host's paths.
const platform = process.env.OMP_BROWSER_PROBE_PLATFORM;
if (platform === "darwin" || platform === "win32" || platform === "linux") {
	Object.defineProperty(process, "platform", { value: platform });
	spyOn(os, "platform").mockReturnValue(platform);
} else if (platform) {
	throw new Error(`Unsupported OMP_BROWSER_PROBE_PLATFORM: ${platform}`);
}
// Chrome for Testing publishes Linux x64 builds only; match the parent fixture's seeded path.
if (platform === "linux") spyOn(os, "arch").mockReturnValue("x64");

// Never reach the network. Some probes allow the resolver to recover from an unavailable
// shell download; the preview probe additionally checks that no install was attempted.
let installAttempts = 0;
spyOn(browsers, "install").mockImplementation(async options => {
	installAttempts++;
	throw new Error(`browser-executable-probe must not download a browser (cacheDir ${options.cacheDir})`);
});

const options = { headless: process.env.OMP_BROWSER_PROBE_HEADLESS === "1" };
const purpose = process.env.OMP_BROWSER_PROBE_PURPOSE;
if (purpose === "needs-download") {
	process.stdout.write(
		JSON.stringify({
			headless: await chromiumNeedsDownload({ headless: true }),
			headed: await chromiumNeedsDownload({ headless: false }),
			default: await chromiumNeedsDownload(),
		}),
	);
} else if (purpose === "preview") {
	const needsDownload = await chromiumNeedsDownload({ headless: true });
	const executable = needsDownload ? null : await ensureChromiumExecutable({ headless: true });
	process.stdout.write(JSON.stringify({ needsDownload, executable, installAttempts }));
} else if (purpose === "selection") {
	process.stdout.write(
		JSON.stringify({
			headless: await ensureChromiumExecutable({ headless: true }),
			headed: await ensureChromiumExecutable({ headless: false }),
			default: await ensureChromiumExecutable(),
		}),
	);
} else if (purpose === "products") {
	const [shell, chrome] = await Promise.all([
		ensureChromiumExecutable({ headless: true }),
		ensureChromiumExecutable({ headless: false }),
	]);
	process.env.PUPPETEER_EXECUTABLE_PATH = "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe";
	const signIn = await ensureSignInChromiumExecutable();
	delete process.env.PUPPETEER_EXECUTABLE_PATH;
	process.stdout.write(
		JSON.stringify({
			shell,
			chrome,
			signIn,
			shellAgain: await ensureChromiumExecutable({ headless: true }),
			chromeAgain: await ensureChromiumExecutable(),
		}),
	);
} else {
	const executable =
		purpose === "sign-in" ? await ensureSignInChromiumExecutable() : await ensureChromiumExecutable(options);
	process.stdout.write(executable ?? "");
}
