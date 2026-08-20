import assert from "node:assert/strict";
import { canRetryInForeground, outcomeAfterCheck, outcomeAfterObservedValues, prepareAction } from "../src/actions.ts";
import { nodeByRef, parseLookResponse } from "../src/outline.ts";
import { ResourceScheduler, StateStore, StaleResourceStateError } from "../src/runtime.ts";
import { SavedStates } from "../src/state.ts";
import { changesBetween, stabilizeRefs } from "../src/view.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const states = new StateStore(2);
const first = states.create("pid:1", 0, { label: "first" });
states.create("pid:2", 0, { label: "second" });
states.create("pid:3", 0, { label: "third" });
assert.equal(states.get(first.stateId), undefined, "bounded state store did not evict oldest state");

let storeTime = 1_000;
const byteAndTtlBounded = new StateStore({
	maxEntries: 10,
	maxBytes: 1_500,
	maxRecordBytes: 1_400,
	ttlMs: 100,
	now: () => storeTime,
});
const byteOldest = byteAndTtlBounded.create("pid:bytes", 0, { value: "a".repeat(900) });
byteAndTtlBounded.create("pid:bytes", 0, { value: "b".repeat(900) });
assert.equal(byteAndTtlBounded.get(byteOldest.stateId), undefined, "byte capacity did not evict the oldest state");
assert.throws(
	() => byteAndTtlBounded.create("pid:bytes", 0, { value: "x".repeat(2_000) }),
	(error) => error?.code === "state_too_large",
	"single-state capacity did not reject an oversized state",
);
const expiring = byteAndTtlBounded.create("pid:ttl", 0, { value: "short" });
storeTime += 101;
byteAndTtlBounded.create("pid:ttl", 0, { value: "new" });
assert.equal(byteAndTtlBounded.get(expiring.stateId), undefined, "TTL cleanup did not run on write");

const rawLook = (lookId, children, image) => parseLookResponse({
	lookId,
	capturedAt: Date.now() / 1000,
	window: { windowId: 1, framePoints: { x: 0, y: 0, w: 800, h: 600 }, scaleFactor: 1, isModal: false, role: "AXWindow", subrole: "AXStandardWindow" },
	image,
	outline: { ref: "window", role: "AXWindow", children },
	timings: {},
});

const baseLook = rawLook("look-1", [
	{ ref: "toolbar", role: "AXToolbar", title: "Toolbar" },
	{ ref: "editor", role: "AXTextArea", value: "", canSetValue: true, isTextInput: true },
]);
const nextLook = rawLook("look-2", [
	{ ref: "inserted", role: "AXStaticText", value: "Status" },
	{ ref: "toolbar", role: "AXToolbar", title: "Toolbar" },
	{ ref: "editor", role: "AXTextArea", value: "hello", canSetValue: true, isTextInput: true },
]);
const imageBytes = Buffer.from("state-store-must-not-retain-this-image").toString("base64");
const imageLook = rawLook("look-image", [{ ref: "button", role: "AXButton", title: "Save" }], {
	jpegBase64: imageBytes,
	mimeType: "image/jpeg",
	width: 800,
	height: 600,
});
const savedStates = new SavedStates();
savedStates.saveDesktop({
	currentTarget: { appName: "Fixture", pid: 1, windowTitle: "Fixture", windowId: 1 },
	currentCapture: { stateId: "state-image", width: 800, height: 600, scaleFactor: 1, timestamp: Date.now() },
	currentLook: imageLook,
	currentOutline: imageLook.parsedOutline,
}, "desktop-pid:1", 0);
const savedImageState = savedStates.get("state-image");
assert(savedImageState, "desktop observation was not saved");
assert(!JSON.stringify(savedImageState).includes(imageBytes), "StateStore retained screenshot base64 bytes");
const hydratedImage = savedStates.hydrate(savedImageState).currentLook?.image;
assert.deepEqual(hydratedImage, { mimeType: "image/jpeg", width: 800, height: 600 }, "stored state did not retain coordinate metadata");
stabilizeRefs(baseLook.parsedOutline, nextLook.parsedOutline);
assert.equal(nextLook.parsedOutline.wireRefToRef.get("editor"), baseLook.parsedOutline.wireRefToRef.get("editor"), "successor state did not preserve a confidently matched ref");
const successorDiff = changesBetween(baseLook.parsedOutline, nextLook.parsedOutline);
assert.equal(successorDiff.useFullView, false, "small successor change unexpectedly required a full view");
assert(successorDiff.changes.some((change) => change.type === "updated" && change.ref === baseLook.parsedOutline.wireRefToRef.get("editor") && change.fields.value === "hello"), "successor diff omitted the editor value change");
assert(successorDiff.changes.some((change) => change.type === "added" && change.ref === nextLook.parsedOutline.wireRefToRef.get("inserted")), "successor diff omitted the added node");

const regeneratedLook = rawLook("look-3", [
	{ ref: "toolbar-new", role: "AXToolbar", title: "Toolbar" },
	{ ref: "editor-new", role: "AXTextArea", value: "updated", canSetValue: true, isTextInput: true },
]);
stabilizeRefs(baseLook.parsedOutline, regeneratedLook.parsedOutline);
const regeneratedEditor = regeneratedLook.parsedOutline.nodes.find((node) => node.wireRef === "editor-new");
assert.equal(regeneratedEditor?.ref, baseLook.parsedOutline.wireRefToRef.get("editor"), "structurally stable nodes did not retain refs when native refs regenerated");
assert.equal(changesBetween(baseLook.parsedOutline, regeneratedLook.parsedOutline).useFullView, false, "regenerated native refs forced an unnecessary full view");

const editor = nextLook.parsedOutline.nodes.find((node) => node.wireRef === "editor");
assert(editor, "editor fixture was not parsed");
const actionEnv = {
	headless: false,
	image: { width: 800, height: 600 },
	node: (ref) => nodeByRef(nextLook.parsedOutline, ref),
	center: (node) => ({ x: node.rect?.x ?? 0, y: node.rect?.y ?? 0 }),
	validatePoint: () => undefined,
};
const preparedClick = prepareAction({ action: "click", ref: editor.ref }, { currentFocus: false }, actionEnv);
assert.equal(preparedClick.params.button, "left", "omitted click.button did not default to left");
assert.equal(preparedClick.params.clickCount, 1, "omitted click.clickCount did not default to one");
assert.equal(preparedClick.establishesFocus, true, "editable semantic clicks should establish transaction focus");
assert("x" in preparedClick.target, "text-input clicks should use their observed center to establish deterministic focus");
assert.equal(preparedClick.needsForeground, true, "text-input clicks should establish focus through foreground pointer input");
const pictureTarget = { ...editor, ref: "@e-picture", wireRef: undefined, isTextInput: false, pictureOnly: true };
const pictureClick = prepareAction({ action: "click", ref: pictureTarget.ref }, { currentFocus: false }, { ...actionEnv, node: () => pictureTarget });
assert.equal(pictureClick.needsForeground, true, "picture-only clicks should use foreground pointer delivery");
const preparedType = prepareAction({ action: "typeText", text: "hello" }, { currentFocus: true }, actionEnv);
assert.equal(preparedType.usesCurrentFocus, true, "focused typing did not preserve click-established focus");
const preparedScroll = prepareAction({ action: "scroll", ref: editor.ref }, { currentFocus: false }, actionEnv);
assert.deepEqual(preparedScroll.params, { scrollX: 0, scrollY: 0 }, "omitted scroll deltas did not default to zero");
const preparedWait = prepareAction({ action: "wait" }, { currentFocus: false }, actionEnv);
assert.deepEqual(preparedWait.params, { ms: 1_000 }, "omitted wait.ms did not default to 1000ms");
assert.equal(canRetryInForeground(preparedType, "didnt", false), true, "side-effect-free failed typing should retry in the foreground");
assert.equal(canRetryInForeground(preparedClick, "unknown", false), false, "ambiguous pointer actions must not be replayed");
assert.equal(outcomeAfterCheck("unknown", "verified"), "worked", "newly verified evidence did not prove the request worked");
assert.equal(outcomeAfterCheck("unknown", "preexisting"), "unknown", "preexisting evidence incorrectly proved the request worked");
assert.equal(outcomeAfterCheck("worked", "failed"), "didnt", "failed verification did not override delivery success");
assert.equal(outcomeAfterObservedValues("didnt", [{ action: "setText", ref: "@e1", text: "saved" }], () => "saved"), "worked", "resulting state did not override stale immediate setText evidence");
assert.equal(outcomeAfterObservedValues("didnt", [{ action: "setText", ref: "@e1", text: "saved" }], () => "old"), "didnt", "mismatched resulting value incorrectly proved setText worked");

const scheduler = new ResourceScheduler();
let active = 0;
let peak = 0;
const work = async () => {
	active += 1;
	peak = Math.max(peak, active);
	await sleep(25);
	active -= 1;
};
await Promise.all([
	scheduler.read("pid:1", work),
	scheduler.read("pid:2", work),
]);
assert.equal(peak, 2, "different resources did not overlap");

active = 0;
peak = 0;
await Promise.all([
	scheduler.read("pid:3", work),
	scheduler.read("pid:3", work),
]);
assert.equal(peak, 1, "same-resource operations overlapped");

await scheduler.write("pid:4", 0, async () => undefined);
await assert.rejects(
	() => scheduler.readAt("pid:4", 0, async () => undefined),
	(error) => error instanceof StaleResourceStateError,
);
await assert.rejects(
	() => scheduler.write("pid:4", 0, async () => undefined),
	(error) => error instanceof StaleResourceStateError,
);

await scheduler.close();
console.log("Runtime concurrency checks passed.");
