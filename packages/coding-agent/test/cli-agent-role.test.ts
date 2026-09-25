import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-ai";
import type { Args } from "@oh-my-pi/pi-coding-agent/cli/args";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions, runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeWithRetries, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const AGENT_BODY = "Review the change before you answer.";
const AGENT_MD = [
	"---",
	"name: launch-reviewer",
	"description: Project agent used by the launch tests.",
	"tools: read, grep",
	"model: prov/agent-model",
	"thinking: high",
	"---",
	AGENT_BODY,
].join("\n");

describe("--agent launch flag", () => {
	let projectDir: string;
	let tempHome: string;
	let modelsDir: TempDir;
	let authStorage: AuthStorage;

	beforeAll(async () => {
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cli-agent-role-"));
		projectDir = path.join(tempHome, "project");
		await fs.mkdir(path.join(projectDir, ".omp", "agents"), { recursive: true });
		await fs.writeFile(path.join(projectDir, ".omp", "agents", "launch-reviewer.md"), AGENT_MD);
		modelsDir = await TempDir.create("@cli-agent-role-");
		authStorage = createInMemoryAuthStorage();
	});

	afterAll(async () => {
		authStorage.close();
		await modelsDir.remove();
		await removeWithRetries(tempHome);
	});

	async function optionsFor(argv: string[], settings = Settings.isolated()): Promise<CreateAgentSessionOptions> {
		const parsed = parseArgs(argv);
		parsed.cwd = projectDir;
		return await buildSessionOptions(
			parsed,
			[],
			SessionManager.inMemory(),
			new ModelRegistry(authStorage, modelsDir.join("models.yml")),
			settings,
		);
	}

	/** Run startup far enough to prove whether the launch reaches session creation. */
	async function runLaunch(parsed: Args, settings: Settings, onCreate: () => void): Promise<void> {
		using sessionDir = TempDir.createSync("@cli-agent-role-launch-");
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = sessionDir.path();
		const launchAuthStorage = createInMemoryAuthStorage();
		try {
			await runRootCommand(parsed, [], {
				discoverAuthStorage: async () => launchAuthStorage,
				settings,
				createAgentSession: async () => {
					onCreate();
					throw new Error("session must not be created");
				},
			});
		} finally {
			launchAuthStorage.close();
		}
	}

	it("parses --agent as a name and keeps the prompt positional", () => {
		const parsed = parseArgs(["--agent", "launch-reviewer", "--print", "hello"]);

		expect(parsed.agent).toBe("launch-reviewer");
		expect(parsed.print).toBe(true);
		expect(parsed.messages).toEqual(["hello"]);
	});

	it("inserts the canonical agent prompt before the dynamic block", async () => {
		const options = await optionsFor(["--agent", "launch-reviewer"]);

		expect(options.agentName).toBe("launch-reviewer");
		const render = options.systemPrompt;
		if (typeof render !== "function") throw new Error("expected a system prompt transformer");
		const rendered = render(["harness", "project context"]);
		expect(Array.isArray(rendered)).toBe(true);
		const blocks = rendered as string[];
		expect(blocks).toHaveLength(3);
		expect(blocks[0]).toBe("harness");
		expect(blocks[1].trim()).toBe(AGENT_BODY);
		expect(blocks[2]).toBe("project context");
	});

	it("uses the agent tool list as the maximum, which --tools cannot widen", async () => {
		const fromAgent = await optionsFor(["--agent", "launch-reviewer"]);
		expect(fromAgent.toolNames).toEqual(["read", "grep", "yield"]);

		const narrowed = await optionsFor(["--agent", "launch-reviewer", "--tools", "read,bash"]);
		expect(narrowed.toolNames).toEqual(["read"]);

		const emptied = await optionsFor(["--agent", "launch-reviewer", "--no-tools"]);
		expect(emptied.toolNames).toEqual([]);
	});

	it("applies the agent model and thinking level as defaults", async () => {
		const options = await optionsFor(["--agent", "launch-reviewer"]);

		expect(options.modelPattern).toEqual(["prov/agent-model"]);
		expect(options.model).toBeUndefined();
		expect(options.thinkingLevel).toBe(Effort.High);
	});

	it("keeps an explicit --model and --thinking above the agent defaults", async () => {
		const options = await optionsFor([
			"--agent",
			"launch-reviewer",
			"--model",
			"prov/cli-model",
			"--thinking",
			"low",
		]);

		expect(options.modelPattern).toBe("prov/cli-model");
		expect(options.thinkingLevel).toBe(Effort.Low);
	});

	it("prefers the settings override over the agent model", async () => {
		const settings = Settings.isolated({
			"task.agentModelOverrides": { "launch-reviewer": "prov/override-model" },
		});

		const options = await optionsFor(["--agent", "launch-reviewer"], settings);

		expect(options.modelPattern).toEqual(["prov/override-model"]);
	});

	it("rejects an unknown agent before the session is created", async () => {
		const parsed = parseArgs(["--agent", "no-such-agent", "--print", "hello"]);
		let created = false;

		await expect(
			runLaunch(parsed, Settings.isolated({ "marketplace.autoUpdate": "off" }), () => {
				created = true;
			}),
		).rejects.toThrow(/Unknown agent "no-such-agent"\. Available: /);
		expect(created).toBe(false);
	});

	it("rejects a disabled agent before the session is created", async () => {
		const parsed = parseArgs(["--agent", "reviewer", "--print", "hello"]);
		const settings = Settings.isolated({
			"marketplace.autoUpdate": "off",
			"task.disabledAgents": ["reviewer"],
		});
		let created = false;

		await expect(
			runLaunch(parsed, settings, () => {
				created = true;
			}),
		).rejects.toThrow(/Agent "reviewer" is disabled in settings\./);
		expect(created).toBe(false);
	});
});
