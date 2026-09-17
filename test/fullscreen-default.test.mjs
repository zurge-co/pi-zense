// Unit tests for applyFullscreenDefault (pure merge of tuiMode=fullscreen into settings.json)
// Guaranteed behavior: writes only when the key is absent / respects the user's own choice / never clobbers a corrupt file
import { strict as assert } from "node:assert";
import test from "node:test";
import { applyFullscreenDefault } from "../extensions/zense-harness/index.ts";

test("absent tuiMode → set fullscreen while preserving existing keys", () => {
	const r = applyFullscreenDefault(JSON.stringify({ theme: "dark", packages: ["npm:pi-zense"] }));
	assert.ok(r?.changed);
	const obj = JSON.parse(r.text);
	assert.equal(obj.theme, "dark");
	assert.deepEqual(obj.packages, ["npm:pi-zense"]);
	assert.equal(obj.tuiMode, "fullscreen");
});

test("missing/empty settings file → create minimal settings with fullscreen", () => {
	for (const raw of [undefined, "", "  \n"]) {
		const r = applyFullscreenDefault(raw);
		assert.ok(r?.changed);
		assert.equal(JSON.parse(r.text).tuiMode, "fullscreen");
	}
});

test("explicit user choice is respected — never overwrite (regular AND fullscreen)", () => {
	for (const v of ["regular", "fullscreen"]) {
		const raw = JSON.stringify({ tuiMode: v });
		const r = applyFullscreenDefault(raw);
		assert.equal(r?.changed, false);
		assert.equal(r?.text, raw); // byte-identical — never reformats the user's file
	}
});

test("unparseable / non-object settings → null (never clobber)", () => {
	assert.equal(applyFullscreenDefault("{ not json"), null);
	assert.equal(applyFullscreenDefault('["array"]'), null);
	assert.equal(applyFullscreenDefault('"plain string"'), null);
	assert.equal(applyFullscreenDefault("42"), null);
});
