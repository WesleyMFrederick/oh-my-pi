// Contract: for a tab on the project-shared browser, the ownership file naming the new page target is
// on disk by the time `acquireTab` resolves, so a client killed right after the open still leaves its
// page reapable by a surviving client. Stub worker and stub CDP browser: no Chromium is launched.
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { daemonRuntimeDir } from "../../src/launch/paths";
import { processStartTime } from "../../src/tools/browser/launch-ledger";
import * as orphanRegistry from "../../src/tools/browser/orphan-registry";
import { resetOrphanRegistryForTest } from "../../src/tools/browser/orphan-registry";
import { type PuppeteerBrowserHandle, holdBrowser } from "../../src/tools/browser/registry";
import type { ReadyInfo, WorkerInbound, WorkerOutbound } from "../../src/tools/browser/tab-protocol";
import {
	acquireTab,
	getTabsMapForTest,
	setTabWorkerSpawnerForTest,
	type WorkerHandle,
} from "../../src/tools/browser/tab-supervisor";

const DAEMON = "omp.browser.headless";
const TARGET_ID = "shared-target-1";

/** A worker that completes the init handshake immediately and reports `TARGET_ID`. */
function fakeWorker(): WorkerHandle {
	const handlers = new Set<(msg: WorkerOutbound) => void>();
	const info: ReadyInfo = {
		url: "about:blank",
		title: "",
		viewport: { width: 1, height: 1 },
		targetId: TARGET_ID,
	};
	return {
		mode: "worker",
		send(msg: WorkerInbound) {
			if (msg.type !== "init") return;
			queueMicrotask(() => {
				for (const handler of handlers) handler({ type: "setup" });
				for (const handler of handlers) handler({ type: "ready", info });
			});
		},
		onMessage(handler) {
			handlers.add(handler);
			return () => handlers.delete(handler);
		},
		onError: () => () => undefined,
		terminate: async () => undefined,
	};
}

describe("acquireTab on the shared browser", () => {
	const projectDirs: string[] = [];

	afterEach(async () => {
		setTabWorkerSpawnerForTest(undefined);
		getTabsMapForTest().clear();
		resetOrphanRegistryForTest();
		for (const dir of projectDirs.splice(0)) {
			await fs.rm(daemonRuntimeDir(dir), { recursive: true, force: true }).catch(() => undefined);
		}
	});

	it("given a shared-daemon handle, when acquireTab resolves, then this process's ownership file already lists the new target with its start time", async () => {
		const projectDir = path.join("/tmp", `omp-shared-tab-test-${crypto.randomUUID()}`);
		projectDirs.push(projectDir);
		setTabWorkerSpawnerForTest(async () => fakeWorker());
		const handle: PuppeteerBrowserHandle = {
			key: "shared",
			kind: { kind: "headless", headless: true },
			// Only the pieces the open path touches: a connection that reports an endpoint and stays connected.
			browser: { connected: true, wsEndpoint: () => "ws://127.0.0.1/devtools/browser/stub" } as never,
			sharedDaemon: { name: DAEMON, projectDir },
			refCount: 0,
			stealth: { browserSession: null, override: null },
		};
		holdBrowser(handle);

		const { tab } = await acquireTab("shared-tab", handle, { timeoutMs: 5_000 });
		expect(tab.targetId).toBe(TARGET_ID);

		const file = path.join(daemonRuntimeDir(projectDir), `${DAEMON}.targets`, `${process.pid}.json`);
		const record = (await Bun.file(file).json()) as { targets: string[]; startTime?: string };
		expect(record.targets).toEqual([TARGET_ID]);
		expect(record.startTime).toBe(await processStartTime(process.pid));
	});

	it("given the ownership write fails, when acquireTab runs, then it throws naming the cause, closes the new target and leaves no tab or hold", async () => {
		const projectDir = path.join("/tmp", `omp-shared-tab-test-${crypto.randomUUID()}`);
		projectDirs.push(projectDir);
		setTabWorkerSpawnerForTest(async () => fakeWorker());
		const closedTargets: string[] = [];
		const session = {
			send: async (method: string, params?: { targetId: string }) => {
				if (method === "Target.closeTarget" && params) closedTargets.push(params.targetId);
				return { success: true, targetInfos: [] };
			},
			detach: async () => undefined,
		};
		const handle: PuppeteerBrowserHandle = {
			key: "shared",
			kind: { kind: "headless", headless: true },
			browser: {
				connected: true,
				wsEndpoint: () => "ws://127.0.0.1/devtools/browser/stub",
				target: () => ({ createCDPSession: async () => session }),
			} as never,
			sharedDaemon: { name: DAEMON, projectDir },
			refCount: 0,
			stealth: { browserSession: null, override: null },
		};
		holdBrowser(handle);
		const write = spyOn(orphanRegistry, "recordSharedTarget").mockRejectedValue(new Error("read-only file system"));
		try {
			const error = await acquireTab("shared-tab", handle, { timeoutMs: 5_000 }).then(
				() => undefined,
				(err: unknown) => err,
			);
			expect((error as Error).message).toContain("read-only file system");
		} finally {
			write.mockRestore();
		}
		expect(closedTargets).toEqual([TARGET_ID]);
		expect(getTabsMapForTest().has("shared-tab")).toBe(false);
		// Only the test's own hold remains: the failed open released the hold it had taken.
		expect(handle.refCount).toBe(1);
	});
});
