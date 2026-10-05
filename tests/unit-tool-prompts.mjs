#!/usr/bin/env node

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeTool, toolPromptsFrom } from "../src/tool-prompts.js";
import { collectToolPrompts, PromptCaptures } from "../src/prompt-capture.js";

const READ = "Read the contents of a file.";

describe("toolPromptsFrom", () => {
	it("joins pi's snippet and guideline maps per tool, dropping tools with neither", () => {
		assert.deepEqual(
			toolPromptsFrom(
				{ read: "Read file contents", grep: " Search file contents ", ls: "  " },
				{ read: ["Use read to examine files instead of cat or sed.", " "], codemode: ["Batch independent calls."], find: [] },
			),
			{
				read: { snippet: "Read file contents", guidelines: ["Use read to examine files instead of cat or sed."] },
				grep: { snippet: "Search file contents", guidelines: [] },
				codemode: { guidelines: ["Batch independent calls."] },
			},
		);
	});

	it("is empty when pi passed neither map", () => {
		assert.deepEqual(toolPromptsFrom(undefined, undefined), {});
	});
});

describe("describeTool", () => {
	it("leaves a tool pi said nothing about unchanged", () => {
		assert.equal(describeTool(READ, undefined), READ);
	});

	it("leads with the snippet and ends with the guidelines", () => {
		assert.equal(
			describeTool(READ, { snippet: "Read file contents", guidelines: ["Use read to examine files instead of cat or sed.", "Prefer offset/limit."] }),
			"Read file contents\n\nRead the contents of a file.\n\nGuidelines:\n- Use read to examine files instead of cat or sed.\n- Prefer offset/limit.",
		);
	});

	it("skips a snippet the description already says verbatim", () => {
		assert.equal(describeTool("Run JavaScript that calls other tools. More.", { snippet: "Run JavaScript that calls other tools", guidelines: [] }),
			"Run JavaScript that calls other tools. More.");
	});
});

describe("collectToolPrompts", () => {
	const PARENT = "parent assembled prompt";
	const CHILD = `${PARENT}\n\n<sub_agent_context>child</sub_agent_context>`;

	it("gives a sub-agent prompt that embeds its parent the parent's tool prompts, its own entries winning", () => {
		const captures = new PromptCaptures();
		captures.record(PARENT, {
			contextFiles: [], skills: [],
			toolPrompts: { read: { guidelines: ["parent read rule"] }, bash: { guidelines: ["parent bash rule"] } },
		});
		captures.record(CHILD, {
			custom: CHILD, contextFiles: [], skills: [],
			toolPrompts: { bash: { guidelines: ["child bash rule"] } },
		});
		assert.deepEqual(collectToolPrompts(captures.resolve(CHILD)), {
			read: { guidelines: ["parent read rule"] },
			bash: { guidelines: ["child bash rule"] },
		});
	});

	it("reaches the parent's tool prompts from a derived capture too", () => {
		const captures = new PromptCaptures();
		captures.record(PARENT, { contextFiles: [], skills: [], toolPrompts: { read: { guidelines: ["parent read rule"] } } });
		const wrapped = `wrapper before\n${PARENT}\nwrapper after`;
		assert.deepEqual(collectToolPrompts(captures.resolveOrDerive(wrapped)), { read: { guidelines: ["parent read rule"] } });
	});
});
