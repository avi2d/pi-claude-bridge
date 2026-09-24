// Test extension: answers every compaction with a message, the way an extension
// that re-briefs the agent after compaction does. Mid-reply, that message lands
// after the pending tool result, in the same model call.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const content = process.env.COMPACT_NUDGE_TEXT;
	if (!content) throw new Error("compact-nudge-extension: COMPACT_NUDGE_TEXT is not set");
	pi.on("session_compact", () => {
		pi.sendMessage({ customType: "compact-nudge", content, display: false });
	});
}
