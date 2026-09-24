// Teardown of a query whose conversation pi compacted away while it sat parked
// on a tool call. The order is the whole point: close() fails the parked call,
// and Claude Code answers that by sending the turn on to the model with the
// entire pre-compaction context.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ctx, resetCtx } from "../src/query-state.js";

const { __test } = await import("../src/index.js");

function parkedQuery() {
	const calls = [];
	let answerInterrupt;
	const sdkQuery = {
		interrupt: () => {
			calls.push("interrupt");
			return new Promise((resolve, reject) => { answerInterrupt = { resolve, reject }; });
		},
		close: () => calls.push("close"),
	};
	const c = ctx();
	c.activeQuery = sdkQuery;
	c.pendingToolCalls.set("toolu_parked", { toolName: "SlowTool", resolve: () => calls.push("handler-released") });
	c.promptStream = { fail: () => calls.push("prompt-stream-failed") };
	__test.activeQueryContexts.add(c);
	return { c, calls, answerInterrupt: () => answerInterrupt };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("discardSupersededQuery", () => {
	beforeEach(() => {
		resetCtx();
		__test.activeQueryContexts.clear();
		__test.setSharedSession({ sessionId: "old-session", cursor: 9, cwd: "/tmp" });
	});

	it("interrupts, and closes only once Claude Code has answered", async () => {
		const { c, calls, answerInterrupt } = parkedQuery();
		__test.discardSupersededQuery(c);
		await settle();
		assert.deepEqual(calls, ["interrupt"]);
		answerInterrupt().resolve();
		await settle();
		assert.deepEqual(calls, ["interrupt", "close"]);
	});

	it("still closes when the interrupt fails", async () => {
		const { c, calls, answerInterrupt } = parkedQuery();
		__test.discardSupersededQuery(c);
		answerInterrupt().reject(new Error("transport closed"));
		await settle();
		assert.deepEqual(calls, ["interrupt", "close"]);
	});

	it("stops routing to the query and hands the top level a fresh context", () => {
		const { c } = parkedQuery();
		__test.discardSupersededQuery(c);
		assert.equal(c.superseded, true);
		assert.equal(c.activeQuery, null);
		assert.equal(__test.activeQueryContexts.has(c), false);
		assert.notEqual(ctx(), c);
		assert.equal(ctx().activeQuery, null);
	});

	it("rebuilds under a new session id, since the dying subprocess may still write the old one", () => {
		const { c } = parkedQuery();
		__test.discardSupersededQuery(c);
		assert.deepEqual(__test.getSharedSession(), { sessionId: "old-session", cursor: 9, cwd: "/tmp", needsRebuild: true, forceRotate: true });
	});
});
