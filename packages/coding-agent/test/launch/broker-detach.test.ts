// Integration test — spawns a real client process that spawns a real broker. The contract (M7, M8): the
// broker is not in its spawning client's process tree, so a `pgrep -P` tree-kill of that client
// (what Paseo does on agent close) cannot take down the broker that other clients depend on.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import { readLiveDaemonBrokerPid } from "../../src/launch/presence";

const CLIENT_MODULE = path.resolve(import.meta.dir, "../../src/launch/client.ts");

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Descendants of `root`, via the same `pgrep -P` walk a tree-kill performs. */
async function descendants(root: number): Promise<number[]> {
	const result = Bun.spawnSync(["pgrep", "-P", String(root)]);
	const children = result.stdout.toString().split("\n").filter(Boolean).map(Number);
	const nested = await Promise.all(children.map(descendants));
	return [...children, ...nested.flat()];
}

async function parentOf(pid: number): Promise<number> {
	const out = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)])
		.stdout.toString()
		.trim();
	return Number(out);
}

describe("daemon broker process tree", () => {
	let tempDir: TempDir;
	let sentinel: DaemonBrokerClient | undefined;
	let brokerPid: number | undefined;

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-broker-detach-");
	});

	afterEach(async () => {
		// The broker was started by this test through the client below; shut it down over its own RPC.
		await sentinel?.request({ op: "shutdown" }).catch(() => undefined);
		sentinel?.close();
		tempDir[Symbol.dispose]();
	});

	it("given a client that spawned the broker, when the client's tree is killed, then the broker survives and is re-parented to init (M7, M8)", async () => {
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "run");
		await fs.mkdir(projectDir);
		const script = path.join(tempDir.path(), "client.ts");
		await Bun.write(
			script,
			`import { createDaemonBrokerClient } from ${JSON.stringify(CLIENT_MODULE)};
const client = await createDaemonBrokerClient(${JSON.stringify(projectDir)}, { runtimeDir: ${JSON.stringify(runtimeDir)}, idleGraceMs: 60000 });
await client.request({ op: "ping" });
console.log("ready");
setInterval(() => {}, 1000);
`,
		);
		const spawner = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "inherit" });
		try {
			const reader = spawner.stdout.getReader();
			let seen = "";
			while (!seen.includes("ready")) {
				const chunk = await reader.read();
				if (chunk.done) throw new Error("client exited before ready");
				seen += new TextDecoder().decode(chunk.value);
			}
			brokerPid = await readLiveDaemonBrokerPid(runtimeDir);
			if (brokerPid === undefined) throw new Error("broker not running");
			// A second client keeps a connection so the broker has a reason to live after the spawner dies.
			sentinel = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 60_000 });

			expect(await parentOf(brokerPid)).toBe(1);
			expect(await descendants(spawner.pid)).not.toContain(brokerPid);

			// Tree-kill the spawning client: its descendants first, then the client. Only processes this test started.
			for (const pid of await descendants(spawner.pid)) process.kill(pid, "SIGKILL");
			spawner.kill("SIGKILL");
			await spawner.exited;

			expect(isAlive(brokerPid)).toBe(true);
			expect((await sentinel.request({ op: "ping" })).op).toBe("ping");
		} finally {
			spawner.kill("SIGKILL");
		}
	}, 30_000);
});
