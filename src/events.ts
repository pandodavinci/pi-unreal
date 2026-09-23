/**
 * Maps unreal-agent-runner JSONL lines (persisted session items) to compact bridge events,
 * and accumulates run statistics. Pure: no I/O.
 *
 * Runner line shapes (see unreal-agent cmd/internal/agentrunner/run.go):
 *   {"Sequence":n,"Kind":"input"|"turn"|"model_response"|"tool_call_status"|...,"Data":{...}}
 *   {"type":"error","message":"..."}   (fatal, emitted once before exit 1)
 */

export type BridgeEvent =
	| { kind: "turn"; turnId: string }
	| { kind: "text"; text: string; phase: string }
	| { kind: "reasoning"; summary: string }
	| { kind: "tool_call"; callId: string; name: string; args: string }
	| { kind: "tool_error"; callId: string; error: string }
	| {
			kind: "operation_done";
			id: string;
			type: string;
			status: string;
			exitCode: number | null;
			output: string;
			error: string;
	  }
	| { kind: "model_failure"; message: string }
	| { kind: "runner_error"; message: string }
	/** Ephemeral streaming preview (runner include_partial_messages). partialKind "reset" = discard previews. */
	| { kind: "partial"; partialKind: "text" | "reasoning" | "reset"; itemId: string; delta: string }
	| { kind: "raw"; line: string };

export interface RunStats {
	modelCalls: number;
	toolCalls: number;
	operationsCompleted: number;
	/** Peak number of operations in flight at once (proxy for async concurrency). */
	maxConcurrentOperations: number;
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	/** Tool calls rejected at validation/translation (Status.Error). */
	toolErrors: number;
	/** Operations that ended failed/canceled or carried an error (e.g. ViewImage Result.Error). */
	operationFailures: number;
	/** Shell operations that completed with a non-zero exit code (e.g. failing tests). */
	nonZeroExits: number;
	/** Persisted model responses with Failure set (provider retries happen before this and are not counted). */
	modelFailures: number;
}

export function emptyStats(): RunStats {
	return {
		modelCalls: 0,
		toolCalls: 0,
		operationsCompleted: 0,
		maxConcurrentOperations: 0,
		inputTokens: 0,
		cachedInputTokens: 0,
		outputTokens: 0,
		reasoningTokens: 0,
		toolErrors: 0,
		operationFailures: 0,
		nonZeroExits: 0,
		modelFailures: 0,
	};
}

/** Stateful translator: one per run. */
export class EventMapper {
	readonly stats = emptyStats();
	/** Last assistant message; phase "final_answer" wins over commentary. */
	finalText = "";
	/** True once the runner persisted the user's prompt (an external input item), i.e. Unreal's session has it. */
	promptPersisted = false;
	/** Stop reason of the last model response ("complete", "max_output_tokens", "refused"), or "failed". */
	lastStop = "";
	#finalIsAnswer = false;
	#inFlight = new Set<string>();
	#done = new Set<string>();

	/** Never throws: unparseable or structurally unexpected lines become raw events. */
	map(line: string): BridgeEvent[] {
		const trimmed = line.trim();
		if (!trimmed) return [];
		try {
			return this.#map(JSON.parse(trimmed));
		} catch {
			return [{ kind: "raw", line: trimmed }];
		}
	}

	#map(item: any): BridgeEvent[] {
		if (item?.type === "error") {
			return [{ kind: "runner_error", message: String(item.message ?? "unknown error") }];
		}
		if (item?.type === "partial") {
			const partialKind = item.kind === "text" || item.kind === "reasoning" ? item.kind : "reset";
			return [{ kind: "partial", partialKind, itemId: String(item.item_id ?? ""), delta: String(item.delta ?? "") }];
		}
		switch (item?.Kind) {
			case "input":
				if (item.Data?.Kind === "external") this.promptPersisted = true;
				return [];
			case "turn":
				return [{ kind: "turn", turnId: String(item.Data?.ID ?? "") }];
			case "model_response":
				return this.#modelResponse(item.Data?.Response);
			case "tool_call_status":
				return this.#toolCallStatus(item.Data);
			default:
				return [];
		}
	}

	#modelResponse(response: any): BridgeEvent[] {
		if (!response) return [];
		const events: BridgeEvent[] = [];
		this.stats.modelCalls++;
		const usage = response.Usage ?? {};
		this.stats.inputTokens += usage.InputTokens ?? 0;
		this.stats.cachedInputTokens += usage.CachedInputTokens ?? 0;
		this.stats.outputTokens += usage.OutputTokens ?? 0;
		this.stats.reasoningTokens += usage.ReasoningTokens ?? 0;
		this.lastStop = response.Failure ? "failed" : String(response.Stop ?? "");
		if (response.Failure) {
			this.stats.modelFailures++;
			events.push({ kind: "model_failure", message: JSON.stringify(response.Failure) });
		}
		for (const out of response.Output ?? []) {
			const data = out?.Data ?? {};
			if (out?.Type === "message" && typeof data.Text === "string") {
				const phase = String(data.Phase ?? "");
				events.push({ kind: "text", text: data.Text, phase });
				if (phase === "final_answer" || !this.#finalIsAnswer) {
					this.finalText = data.Text;
					this.#finalIsAnswer = phase === "final_answer";
				}
			} else if (out?.Type === "reasoning") {
				const summary = (Array.isArray(data.Summary) ? data.Summary : []).map(String).join(" ").trim();
				if (summary) events.push({ kind: "reasoning", summary });
			} else if (out?.Type === "tool_call") {
				this.stats.toolCalls++;
				events.push({
					kind: "tool_call",
					callId: String(data.CallID ?? ""),
					name: String(data.Name ?? "?"),
					args: String(data.Arguments ?? ""),
				});
			}
		}
		return events;
	}

	#toolCallStatus(data: any): BridgeEvent[] {
		if (!data) return [];
		const events: BridgeEvent[] = [];
		const error = data.Status?.Error;
		if (error) {
			this.stats.toolErrors++;
			events.push({ kind: "tool_error", callId: String(data.CallID ?? ""), error: String(error) });
		}
		for (const op of data.Operations ?? []) {
			const id = String(op?.ID ?? "");
			if (!id || this.#done.has(id)) continue;
			const status = String(op?.Status ?? "");
			if (status === "completed" || status === "failed" || status === "canceled") {
				this.#inFlight.delete(id);
				this.#done.add(id);
				this.stats.operationsCompleted++;
				// Shell results carry Out/Err/ExitCode; ViewImage results carry Error; any op may set TerminalError.
				const result = op.State?.Result ?? {};
				const exitCode = typeof result.ExitCode === "number" ? result.ExitCode : null;
				const error = [op.State?.TerminalError, result.Error].filter(Boolean).map(String).join("; ");
				if (status !== "completed" || error) this.stats.operationFailures++;
				else if (exitCode !== null && exitCode !== 0) this.stats.nonZeroExits++;
				events.push({
					kind: "operation_done",
					id,
					type: String(op.Type ?? ""),
					status,
					exitCode,
					output: String(result.Out ?? "") + String(result.Err ?? ""),
					error,
				});
			} else {
				this.#inFlight.add(id);
				this.stats.maxConcurrentOperations = Math.max(this.stats.maxConcurrentOperations, this.#inFlight.size);
			}
		}
		return events;
	}
}

/** One-line human rendering of an event for widgets/progress. Partials render as "" (callers skip them). */
export function describe(event: BridgeEvent): string {
	const clip = (s: string, n = 160) => {
		const flat = s.replace(/\s+/g, " ").trim();
		return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
	};
	switch (event.kind) {
		case "turn":
			return "· model turn";
		case "text":
			return `${event.phase === "final_answer" ? "✔" : "»"} ${clip(event.text)}`;
		case "reasoning":
			return `~ ${clip(event.summary)}`;
		case "tool_call": {
			let args = event.args;
			try {
				const parsed = JSON.parse(args);
				args = parsed.command ?? parsed.path ?? args;
			} catch {}
			return `$ ${event.name}: ${clip(args, 120)}`;
		}
		case "tool_error":
			return `! tool error: ${clip(event.error)}`;
		case "operation_done":
			return `  ↳ ${event.type} ${event.status === "completed" ? `exit=${event.exitCode ?? "?"}` : event.status}${event.error ? ` ${clip(event.error, 80)}` : ""}`;
		case "model_failure":
			return `! model failure: ${clip(event.message)}`;
		case "runner_error":
			return `! runner error: ${clip(event.message)}`;
		case "raw":
			return `? ${clip(event.line)}`;
		case "partial":
			return "";
	}
}
