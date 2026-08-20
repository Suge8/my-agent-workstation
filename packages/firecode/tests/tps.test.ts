import { describe, expect, test } from "bun:test";
import { registerTps, type TpsStatus } from "../statusbar/tps.js";

type EventHandler = (event: any, ctx: any) => void;

function createHarness() {
	const handlers = new Map<string, EventHandler>();
	const updates: Array<TpsStatus | undefined> = [];
	let currentTime = 1_000;
	const pi = {
		on(name: string, handler: EventHandler) {
			handlers.set(name, handler);
		},
	};
	registerTps(pi as never, (status) => updates.push(status), () => currentTime);
	return {
		handlers,
		updates,
		setTime(value: number) {
			currentTime = value;
		},
	};
}

function assistantDelta(delta = "x".repeat(400)) {
	return {
		message: { role: "assistant", usage: { output: 0 } },
		assistantMessageEvent: { type: "text_delta", delta },
	};
}

describe("footer response timing", () => {
	test("shows throttled cumulative TPS after enough live output", () => {
		const harness = createHarness();
		harness.handlers.get("before_provider_request")?.({}, {});

		harness.setTime(1_500);
		harness.handlers.get("message_update")?.(assistantDelta(), {});
		expect(harness.updates.at(-1)).toEqual({ phase: "live" });

		harness.setTime(2_400);
		harness.handlers.get("message_update")?.(assistantDelta(), {});
		expect(harness.updates).toHaveLength(1);

		harness.setTime(2_500);
		harness.handlers.get("message_update")?.(assistantDelta(), {});
		expect(harness.updates.at(-1)).toEqual({ phase: "live", tokensPerSecond: 300 });

		harness.setTime(2_600);
		harness.handlers.get("message_update")?.(assistantDelta(), {});
		expect(harness.updates).toHaveLength(2);
	});

	test("publishes official final timing and retains it while the next request waits", () => {
		const harness = createHarness();
		harness.handlers.get("before_provider_request")?.({}, {});
		harness.setTime(1_500);
		harness.handlers.get("message_update")?.(assistantDelta(), {});
		harness.setTime(2_500);
		harness.handlers.get("message_update")?.(assistantDelta(), {});
		harness.setTime(3_000);
		harness.handlers.get("message_end")?.(
			{ message: { role: "assistant", usage: { output: 120 } } },
			{},
		);

		expect(harness.updates.at(-1)).toEqual({
			phase: "complete",
			elapsedSeconds: 2,
			tokensPerSecond: 120,
		});
		const completedUpdates = harness.updates.length;

		harness.setTime(4_000);
		harness.handlers.get("before_provider_request")?.({}, {});
		harness.handlers.get("message_start")?.({ message: { role: "assistant" } }, {});
		expect(harness.updates).toHaveLength(completedUpdates);

		harness.setTime(4_500);
		harness.handlers.get("message_update")?.(assistantDelta(), {});
		expect(harness.updates.at(-1)).toEqual({ phase: "live" });
	});

	test("keeps the previous result when a request fails before output", () => {
		const harness = createHarness();
		harness.handlers.get("before_provider_request")?.({}, {});
		harness.setTime(1_500);
		harness.handlers.get("message_update")?.(assistantDelta(), {});
		harness.setTime(2_500);
		harness.handlers.get("message_update")?.(assistantDelta(), {});
		harness.handlers.get("message_end")?.(
			{ message: { role: "assistant", usage: { output: 80 } } },
			{},
		);
		const completed = harness.updates.at(-1);
		const completedUpdates = harness.updates.length;

		harness.setTime(3_000);
		harness.handlers.get("before_provider_request")?.({}, {});
		harness.setTime(4_000);
		harness.handlers.get("message_end")?.(
			{ message: { role: "assistant", usage: { output: 0 } } },
			{},
		);
		expect(harness.updates).toHaveLength(completedUpdates);
		expect(harness.updates.at(-1)).toEqual(completed);
	});

	test("clears stale timing on model and session changes", () => {
		const harness = createHarness();
		harness.handlers.get("model_select")?.({}, {});
		harness.handlers.get("session_start")?.({}, {});
		harness.handlers.get("session_shutdown")?.({}, {});
		expect(harness.updates).toEqual([undefined, undefined, undefined]);
	});
});
