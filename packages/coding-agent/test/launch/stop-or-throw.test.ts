// Contract (M23): when a daemon that must be replaced cannot be stopped, the caller gets an error naming
// its pid instead of silently starting a second daemon under the same name.
import { describe, expect, it } from "bun:test";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import type { DaemonBrokerClient } from "../../src/launch/client";
import { stopOrThrow } from "../../src/launch/ensure";
import type { DaemonOperation, DaemonRpcResult } from "../../src/launch/protocol";

function snapshot(state: DaemonSnapshot["state"]): DaemonSnapshot {
	return { name: "browser", pid: 4321, state } as DaemonSnapshot;
}

function brokerWith(stopError: Error | undefined, stateAfter: DaemonSnapshot["state"]): DaemonBrokerClient {
	return {
		projectDir: "/fixture",
		onCompletion: () => () => undefined,
		close: () => undefined,
		request: async (operation: DaemonOperation): Promise<DaemonRpcResult> => {
			if (operation.op === "stop") {
				if (stopError) throw stopError;
				return { op: "stop", daemon: snapshot("exited") };
			}
			if (operation.op === "describe") {
				return { op: "describe", daemon: snapshot(stateAfter), spec: {} as never };
			}
			throw new Error(`unexpected ${operation.op}`);
		},
	};
}

describe("stopOrThrow", () => {
	it("given a stop that fails while the daemon is still running, then it throws naming the pid", async () => {
		const client = brokerWith(new Error("did not stop"), "running");
		await expect(stopOrThrow(client, "browser", "Shared browser")).rejects.toThrow(/pid 4321/);
	});

	it("given a stop that fails but the daemon has exited meanwhile, then the replacement may proceed", async () => {
		const client = brokerWith(new Error("raced"), "exited");
		await expect(stopOrThrow(client, "browser", "Shared browser")).resolves.toBeUndefined();
	});
});
