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
if (platform === "darwin" || platform === "win32") {
	Object.defineProperty(process, "platform", { value: platform });
	spyOn(os, "platform").mockReturnValue(platform);
} else if (platform) {
	throw new Error(`Unsupported OMP_BROWSER_PROBE_PLATFORM: ${platform}`);
}

// The parent seeds every executable the probe may select. Resolving anything else would start a
// Chrome for Testing download, which stalls the probe on the network; fail it instead.
spyOn(browsers, "install").mockImplementation(async options => {
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
