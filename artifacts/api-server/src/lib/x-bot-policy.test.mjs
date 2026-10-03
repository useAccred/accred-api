import assert from "node:assert/strict";
import test from "node:test";
import { isStaleXBotPost, isTerminalXBotReplyStatus, parseXBotIntent } from "./x-bot-policy.ts";

test("only a command right after the bot handle gets a reply", () => {
  assert.equal(parseXBotIntent("@useAccred balance"), "balance");
  assert.equal(parseXBotIntent("@someone @useAccred Credits please"), "balance");
  assert.equal(parseXBotIntent("hey @useAccred /status"), "status");
  assert.equal(parseXBotIntent("@useAccred help"), "help");
  assert.equal(parseXBotIntent("@useAccred nice project!"), "ignore");
  assert.equal(parseXBotIntent("@useAccred"), "ignore");
  assert.equal(parseXBotIntent("great launch, balance looks good"), "ignore");
});

test("execution words are rejected as read-only", () => {
  for (const w of ["buy", "sell", "send", "swap"]) assert.equal(parseXBotIntent(`@useAccred ${w} 10`), "rejected");
});

test("reply outcome state prevents blind retry of pending/unknown X writes", () => {
  assert.equal(isTerminalXBotReplyStatus("posted"), true);
  assert.equal(isTerminalXBotReplyStatus("post_unknown"), true);
  assert.equal(isTerminalXBotReplyStatus("pending"), false);
  assert.equal(isStaleXBotPost("posting", new Date(10_000), 310_000), true);
  assert.equal(isStaleXBotPost("pending", null, 310_000), false);
});
