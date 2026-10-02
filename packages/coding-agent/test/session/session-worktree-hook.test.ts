import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionWorktree } from "@oh-my-pi/pi-coding-agent/session/session-worktree";

function git(cwd: string, ...args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
	return result.stdout.toString().trim();
}

function writeHook(repo: string, body: string): void {
	const hook = path.join(repo, ".git", "hooks", "post-checkout");
	fs.mkdirSync(path.dirname(hook), { recursive: true });
	fs.writeFileSync(hook, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

describe("/wt post-checkout hook", () => {
	let tempRoot: string;
	let repo: string;
	let previousWorktreeDir: string | undefined;

	beforeEach(() => {
		tempRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "omp-wt-hook-")));
		repo = path.join(tempRoot, "repo");
		fs.mkdirSync(repo);
		git(repo, "init", "-q");
		git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
		previousWorktreeDir = process.env.OMP_WORKTREE_DIR;
		process.env.OMP_WORKTREE_DIR = path.join(tempRoot, "wt");
	});

	afterEach(() => {
		if (previousWorktreeDir === undefined) delete process.env.OMP_WORKTREE_DIR;
		else process.env.OMP_WORKTREE_DIR = previousWorktreeDir;
		fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	it("runs post-checkout inside the new worktree with git's new-worktree arguments", async () => {
		// Given a repository whose post-checkout hook records its arguments and cwd
		const log = path.join(tempRoot, "hook.log");
		writeHook(repo, `echo "$1 $2 $3 $(pwd -P)" > '${log}'`);
		const head = git(repo, "rev-parse", "HEAD");

		// When /wt creates a worktree
		const worktree = await createSessionWorktree(repo, Settings.isolated({}), "wt/hook");

		// Then the hook ran once in the worktree as `git worktree add` would run it
		expect(fs.readFileSync(log, "utf8").trim()).toBe(`${"0".repeat(head.length)} ${head} 1 ${worktree.path}`);
		expect(worktree.hookError).toBeUndefined();
	});

	it("keeps the worktree and reports the failure when the hook exits non-zero", async () => {
		// Given a repository whose post-checkout hook fails
		writeHook(repo, "echo setup broke >&2; exit 3");

		// When /wt creates a worktree
		const worktree = await createSessionWorktree(repo, Settings.isolated({}), "wt/broken");

		// Then the worktree exists and the failure is surfaced with the hook's output
		expect(fs.existsSync(worktree.path)).toBe(true);
		expect(worktree.hookError).toBe("post-checkout hook exited 3: setup broke");
	});
});
