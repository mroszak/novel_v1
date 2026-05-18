import assert from "node:assert/strict";
import test from "node:test";

import { parseAnthropicJson } from "../src/utils/parse-anthropic-json.js";

test("parseAnthropicJson parses fenced JSON", () => {
  assert.deepEqual(parseAnthropicJson("```json\n{\"ok\":true}\n```"), { ok: true });
  assert.deepEqual(parseAnthropicJson("```\n{\"ok\":true}\n```"), { ok: true });
});

test("parseAnthropicJson parses JSON embedded in commentary", () => {
  assert.deepEqual(parseAnthropicJson("Here is the plan: {\"ok\":true} -- end"), { ok: true });
});

test("parseAnthropicJson throws on malformed JSON", () => {
  assert.throws(() => parseAnthropicJson("{\"ok\":true,}"));
});
