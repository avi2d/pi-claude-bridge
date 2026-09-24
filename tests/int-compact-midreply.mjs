#!/usr/bin/env node
// Mid-reply: after a tool result and before the next model call, while the
// query that asked for the tool is still live.
//
// pi, the bridge and a real Claude Code run against a scripted stub of the
// Messages API rather than the real one: it costs nothing, and the recorded
// request bodies show what each model call actually carried.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const MODEL = "claude-bridge/claude-haiku-4-5";
const TIMEOUT = 120_000;
const SLOW_TOOL = "mcp__custom-tools__SlowTool";
const CALL_SLOW_TOOL = "CALL-SLOWTOOL";
const AFTER_TOOL_REPLY = "continued-after-tool";
const NUDGE = "POST-COMPACT-NUDGE: re-read the task before continuing.";
const PADDING = Array.from({ length: 800 }, (_, i) => `padding line ${i}: ${"lorem ipsum dolor ".repeat(3)}`).join("\n");
const PADDING_TOKENS = Math.round(PADDING.length / 4);

const sse = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

function blocks(message) {
	return typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
}

function streamedReply(id, inputTokens, block, stopReason) {
	const usage = { input_tokens: inputTokens, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
	const start = block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} };
	const delta = block.type === "text"
		? { type: "text_delta", text: block.text }
		: { type: "input_json_delta", partial_json: JSON.stringify(block.input) };
	return sse("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", content: [], model: "stub", stop_reason: null, stop_sequence: null, usage } })
		+ sse("content_block_start", { type: "content_block_start", index: 0, content_block: start })
		+ sse("content_block_delta", { type: "content_block_delta", index: 0, delta })
		+ sse("content_block_stop", { type: "content_block_stop", index: 0 })
		+ sse("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } })
		+ sse("message_stop", { type: "message_stop" });
}

const isMainConversation = (body) => (body.tools ?? []).some((tool) => tool.name === SLOW_TOOL);

const carriesToolResult = (messages, id) => messages.some((m) => blocks(m).some((b) => b.type === "tool_result" && b.tool_use_id === id));

// Summaries come from the isolated path, which serves no tools. Usage is sized
// from the request so the numbers pi compacts on track what was actually sent.
async function stubApi() {
	const requests = [];
	const unanswered = new Set();
	const reply = (body, n) => {
		const inputTokens = Math.ceil(JSON.stringify([body.system, body.messages]).length / 4);
		const text = (t) => streamedReply(`msg_stub_${n}`, inputTokens, { type: "text", text: t }, "end_turn");
		if (!isMainConversation(body)) return text(`STUB-SUMMARY-${n}`);
		const answered = [...unanswered].find((id) => carriesToolResult(body.messages, id));
		if (answered) {
			unanswered.delete(answered);
			return text(AFTER_TOOL_REPLY);
		}
		if (blocks(body.messages.at(-1)).some((b) => b.type === "text" && b.text.includes(CALL_SLOW_TOOL))) {
			unanswered.add(`toolu_stub_${n}`);
			return streamedReply(`msg_stub_${n}`, inputTokens, { type: "tool_use", id: `toolu_stub_${n}`, name: SLOW_TOOL, input: { seconds: 2 } }, "tool_use");
		}
		return text(`STUB-REPLY-${n}`);
	};
	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			if (req.method !== "POST" || new URL(req.url, "http://stub").pathname !== "/v1/messages") {
				res.writeHead(404).end();
				return;
			}
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			requests.push(body);
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(reply(body, requests.length));
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { requests, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

function mainRequests(requests, matches) {
	return requests.filter((body) => isMainConversation(body) && matches(body.messages));
}

function contextTokens(usage) {
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

// Every model call after `compaction` must be built from pi's compacted history:
// the summary in, the summarized-away seed out, and a context pi sees shrink by
// at least the padding it dropped.
function assertCarriesCompaction({ label, requests, compaction, marker, nextUsage }) {
	assert.ok(requests.length > 0, `${label}: no model call followed the compaction`);
	const summaries = compaction.result.summary.match(/STUB-SUMMARY-\d+/g) ?? [];
	assert.ok(summaries.length > 0, `${label}: compaction summary came from somewhere other than the stub: ${compaction.result.summary.slice(0, 200)}`);
	for (const [i, request] of requests.entries()) {
		const sent = JSON.stringify(request.messages);
		for (const summary of summaries) {
			assert.ok(sent.includes(summary), `${label}: model call ${i + 1} of ${requests.length} lacks the compaction summary ${summary}`);
		}
		assert.ok(!sent.includes(marker), `${label}: model call ${i + 1} of ${requests.length} still carries ${marker}, which the compaction summarized away`);
	}
	const before = compaction.result.tokensBefore;
	const after = contextTokens(nextUsage);
	assert.ok(after < before - PADDING_TOKENS / 2,
		`${label}: context did not shrink across the compaction: ${before} before, ${after} on the next call`);
	console.log(`  ${label}: ${before} → ${after} tokens`);
}

async function runCompactions({ nudge }) {
	const api = await stubApi();
	const agentDir = mkdtempSync(join(tmpdir(), "compact-midreply-agent-"));
	// keepRecentTokens:1 cuts at the newest assistant message, so the padded seed
	// is always summarized away rather than kept.
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
		compaction: { enabled: false, reserveTokens: 199_000, keepRecentTokens: 1 },
	}));
	const harness = createRpcHarness({
		name: nudge ? "compact-midreply-nudge" : "compact-midreply",
		args: [
			"-e", "./tests/fixtures/slow-tool-extension.ts",
			...(nudge ? ["-e", "./tests/fixtures/compact-nudge-extension.ts"] : []),
			"--model", MODEL,
		],
		env: { PI_CODING_AGENT_DIR: agentDir, ANTHROPIC_BASE_URL: api.url, COMPACT_NUDGE_TEXT: NUDGE },
		defaultTimeout: TIMEOUT,
	});
	const { startAndWait, stop, send, promptAndWait, waitForMatch, addListener, DEBUG_LOG } = harness;
	const events = [];
	addListener((msg) => events.push(msg));
	// One compaction per arming: the threshold sits below any context this test
	// builds, so left enabled pi would compact again on every call.
	addListener((msg) => {
		if (msg.type === "compaction_start") send({ type: "set_auto_compaction", enabled: false }).catch(() => {});
	});
	const nextAssistantUsage = (compaction) => {
		const from = events.indexOf(compaction);
		return events.slice(from).find((msg) => msg.type === "message_end" && msg.message?.role === "assistant")?.message.usage;
	};

	await startAndWait();
	try {
		await promptAndWait(`SEED MARKER-BETWEEN\n${PADDING}`);
		await send({ type: "set_auto_compaction", enabled: true });
		const betweenEnd = waitForMatch((msg) => msg.type === "compaction_end", "between-replies compaction_end");
		await promptAndWait("BETWEEN-REPLIES: reply briefly.");
		const between = await betweenEnd;
		assert.equal(between.aborted, false, `between-replies compaction aborted: ${JSON.stringify(between)}`);
		assertCarriesCompaction({
			label: "between replies",
			requests: mainRequests(api.requests, (messages) => JSON.stringify(blocks(messages.at(-1))).includes("BETWEEN-REPLIES")),
			compaction: between,
			marker: "MARKER-BETWEEN",
			nextUsage: nextAssistantUsage(between),
		});

		await promptAndWait(`SEED MARKER-MIDREPLY\n${PADDING}`);
		let slowToolCallId;
		const disarm = addListener((msg) => {
			if (msg.type === "tool_execution_start" && msg.toolName === "SlowTool") {
				slowToolCallId = msg.toolCallId;
				send({ type: "set_auto_compaction", enabled: true }).catch(() => {});
			}
		});
		const midEnd = waitForMatch((msg) => msg.type === "compaction_end", "mid-reply compaction_end");
		const answer = await promptAndWait(`${CALL_SLOW_TOOL}: call SlowTool once, then reply.`);
		disarm();
		const mid = await midEnd;
		assert.equal(mid.aborted, false, `mid-reply compaction aborted: ${JSON.stringify(mid)}`);
		assert.ok(slowToolCallId, "SlowTool never ran, so no compaction could fire mid-reply");
		const toolEnd = events.findIndex((msg) => msg.type === "tool_execution_end" && msg.toolCallId === slowToolCallId);
		assert.ok(toolEnd !== -1 && toolEnd < events.indexOf(mid),
			"the compaction did not fire between the tool result and the next model call");

		const continuations = mainRequests(api.requests, (messages) => carriesToolResult(messages, slowToolCallId));
		assertCarriesCompaction({
			label: "mid-reply",
			requests: continuations,
			compaction: mid,
			marker: "MARKER-MIDREPLY",
			nextUsage: nextAssistantUsage(mid),
		});
		if (nudge) {
			assert.ok(continuations.every((body) => JSON.stringify(body.messages).includes(NUDGE)),
				"the message a session_compact handler queued never reached Claude Code");
		}
		assert.ok(answer.includes(AFTER_TOOL_REPLY), `the interrupted reply did not continue past the tool result. Got: ${answer.slice(0, 200)}`);

		await promptAndWait("AFTER-MIDREPLY: reply briefly.");
		const nextTurn = mainRequests(api.requests, (messages) => JSON.stringify(blocks(messages.at(-1))).includes("AFTER-MIDREPLY"));
		assert.equal(nextTurn.length, 1, `expected one model call for the turn after the continued reply, got ${nextTurn.length}`);
		const nextSent = JSON.stringify(nextTurn[0].messages);
		const kept = [...mid.result.summary.match(/STUB-SUMMARY-\d+/g), AFTER_TOOL_REPLY];
		assert.ok(kept.every((text) => nextSent.includes(text)) && !nextSent.includes("MARKER-MIDREPLY"),
			"the turn after the continued reply is not built on the compacted history it continued");

		await new Promise((r) => setTimeout(r, 1500));
		const compactions = events.filter((msg) => msg.type === "compaction_end").length;
		assert.equal(compactions, 2, `expected one compaction per arming, got ${compactions}`);
	} catch (error) {
		for (const [i, body] of api.requests.entries()) {
			const shape = body.messages.map((m) => `${m.role}[${blocks(m).map((b) => b.type).join(",")}]`).join(" ");
			const tail = blocks(body.messages.at(-1)).at(-1);
			console.log(`  request ${i + 1}${isMainConversation(body) ? "" : " (summary)"}: ${shape} — ends ${JSON.stringify(tail.text ?? tail.content).slice(0, 80)}`);
		}
		console.log(`  Debug log: ${DEBUG_LOG}`);
		throw error;
	} finally {
		await stop();
		api.close();
		rmSync(agentDir, { recursive: true, force: true });
	}
}

test("a compaction reaches Claude Code between replies and mid-reply", { timeout: 4 * TIMEOUT }, async () => {
	await runCompactions({ nudge: false });
});

test("a mid-reply compaction reaches Claude Code with a message queued behind the tool result", { timeout: 4 * TIMEOUT }, async () => {
	await runCompactions({ nudge: true });
});
