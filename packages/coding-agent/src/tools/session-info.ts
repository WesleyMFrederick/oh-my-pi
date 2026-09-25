import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ToolSession } from ".";

const sessionInfoSchema = type({ "+": "reject" });

type SessionInfoParams = typeof sessionInfoSchema.infer;

export interface SessionInfoDetails {
	sessionId: string | null;
	sessionName: string | null;
	sessionFile: string | null;
	cwd: string;
	modelProvider: string | null;
	modelId: string | null;
	thinkingLevel: string | null;
	approvalMode: "always-ask" | "write" | "yolo" | null;
	contextUsage: { tokens: number; contextWindow: number; percent: number } | null;
	messageCounts: { user: number; assistant: number; toolCalls: number; toolResults: number; total: number } | null;
	tokenCounts: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } | null;
	cost: number | null;
	streaming: boolean | null;
	compaction: { active: boolean; speculation: "idle" | "running" | "armed" } | null;
}

/** Reports current, non-sensitive metadata for the calling session. */
export class SessionInfoTool implements AgentTool<typeof sessionInfoSchema, SessionInfoDetails> {
	readonly name = "session_info";
	readonly approval = "read" as const;
	readonly label = "Session Info";
	readonly description = "Get non-sensitive information for the owning OMP session.";
	readonly parameters = sessionInfoSchema;
	readonly strict = true;
	readonly intent = "omit" as const;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Get owning OMP session information";

	constructor(private readonly session: ToolSession) {}

	async execute(_id: string, _params: SessionInfoParams): Promise<AgentToolResult<SessionInfoDetails>> {
		const model = this.session.getActiveModel?.();
		const usage = this.session.getUsageStatistics?.();
		const details: SessionInfoDetails = {
			sessionId: this.session.sessionManager?.getSessionId?.() ?? this.session.getSessionId?.() ?? null,
			sessionName: this.session.getSessionName?.() ?? null,
			sessionFile: this.session.getSessionFile() ?? null,
			cwd: this.session.cwd,
			modelProvider: model?.provider ?? null,
			modelId: model?.id ?? null,
			thinkingLevel: this.session.getThinkingLevel?.() ?? null,
			approvalMode: this.session.getApprovalMode?.() ?? null,
			contextUsage: this.session.getContextUsage?.() ?? null,
			messageCounts: this.session.getMessageCounts?.() ?? null,
			tokenCounts: usage
				? {
						input: usage.input,
						output: usage.output,
						cacheRead: usage.cacheRead,
						cacheWrite: usage.cacheWrite,
						total: usage.totalTokens,
					}
				: null,
			cost: usage?.cost ?? null,
			streaming: this.session.getStreamingState?.() ?? null,
			compaction: this.session.getCompactionState?.() ?? null,
		};
		return {
			content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
			details,
		};
	}
}
