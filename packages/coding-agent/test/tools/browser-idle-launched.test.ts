// Contract: which launched-browser tabs the idle sweep may close (and kill). A headless omp-launched
// browser recorded in the ledger idle-closes; a headed one, a `persist` one, one omp did not record,
// and another session's tab never do. Selection is the user-visible decision (M14-M16); the kill
// itself is proven against real fixture processes in browser-launch-ledger.test.ts.
import { describe, expect, it } from "bun:test";
import type { Browser } from "puppeteer-core";
import type { PuppeteerBrowserHandle } from "../../src/tools/browser/registry";
import { isIdleCloseCandidate, type TabSession, type WorkerTabSession } from "../../src/tools/browser/tab-supervisor";

const OWNER = "session-a";
const IDLE_MS = 1_000;
const NOW = 100_000;

// The idle predicate never touches the puppeteer connection; an empty object stands in for it.
const unusedBrowser = {} as Browser;

function launchedTab(overrides: {
	headlessLaunch?: boolean;
	ledgerPid?: number | undefined;
	persist?: boolean;
	owner?: string;
	idleForMs?: number;
}): TabSession {
	const browser: PuppeteerBrowserHandle = {
		key: "app:fixture",
		kind: { kind: "spawned", path: "/fixture", args: [] } as PuppeteerBrowserHandle["kind"],
		refCount: 1,
		browser: unusedBrowser,
		headlessLaunch: overrides.headlessLaunch ?? true,
		ledgerPid: "ledgerPid" in overrides ? overrides.ledgerPid : 4242,
		stealth: { browserSession: null, override: null },
	};
	const tab: WorkerTabSession = {
		backend: "worker",
		name: "t",
		browser,
		targetId: "target",
		state: "alive",
		info: { url: "about:blank", viewport: { width: 1, height: 1 }, targetId: "target" },
		pending: new Map(),
		kindTag: "spawned",
		ownerSessionId: overrides.owner ?? OWNER,
		persist: overrides.persist,
		lastActivityAt: NOW - (overrides.idleForMs ?? IDLE_MS),
		frozen: false,
		worker: {
			send: () => undefined,
			onMessage: () => () => undefined,
			onError: () => () => undefined,
			terminate: async () => undefined,
			mode: "inline",
		},
		activateForScreenshot: false,
	};
	return tab;
}

describe("idle close of launched browsers", () => {
	it("given a headless launched browser idle past the window, then it is a close candidate (M14)", () => {
		expect(isIdleCloseCandidate(launchedTab({}), OWNER, NOW, IDLE_MS)).toBe(true);
	});

	it("given the same browser still inside the idle window, then it is kept", () => {
		expect(isIdleCloseCandidate(launchedTab({ idleForMs: 10 }), OWNER, NOW, IDLE_MS)).toBe(false);
	});

	it("given a headed launched browser idle past the window, then it is kept until session end (M15)", () => {
		expect(isIdleCloseCandidate(launchedTab({ headlessLaunch: false }), OWNER, NOW, IDLE_MS)).toBe(false);
	});

	it("given a persist tab on a launched browser, then it is kept (M16)", () => {
		expect(isIdleCloseCandidate(launchedTab({ persist: true }), OWNER, NOW, IDLE_MS)).toBe(false);
	});

	it("given a browser omp has no ledger record for, then it is kept", () => {
		expect(isIdleCloseCandidate(launchedTab({ ledgerPid: undefined }), OWNER, NOW, IDLE_MS)).toBe(false);
	});

	it("given another session's tab, then this session's sweep leaves it", () => {
		expect(isIdleCloseCandidate(launchedTab({ owner: "session-b" }), OWNER, NOW, IDLE_MS)).toBe(false);
	});
});
