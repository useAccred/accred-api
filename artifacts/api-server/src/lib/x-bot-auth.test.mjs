import assert from "node:assert/strict";
import test from "node:test";
import { hasValidXBotServiceAuthorization } from "./x-bot-auth.ts";

test("service bearer authentication accepts only the exact credential", () => {
  assert.equal(hasValidXBotServiceAuthorization("Bearer same-secret", "same-secret"), true);
  assert.equal(hasValidXBotServiceAuthorization("Bearer wrong-secret", "same-secret"), false);
  assert.equal(hasValidXBotServiceAuthorization("Basic same-secret", "same-secret"), false);
  assert.equal(hasValidXBotServiceAuthorization(undefined, "same-secret"), false);
  assert.equal(hasValidXBotServiceAuthorization("Bearer token", undefined), false);
});