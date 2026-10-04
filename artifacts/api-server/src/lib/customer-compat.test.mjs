import assert from "node:assert/strict";
import test from "node:test";
import {
  anthropicMessage,
  anthropicStreamFrames,
  anthropicStreamStart,
  clampMaxOutputTokens,
  compatErrorBody,
  compatStreamError,
  flattenContent,
  openAiCompletion,
  openAiStreamFrames,
  parseAnthropicRequest,
  parseOpenAiRequest,
} from "./customer-compat.ts";

const output = {
  id: "provider-1",
  model: "gpt-6-astra",
  content: "x".repeat(2500),
  usage: { inputTokens: 12, outputTokens: 34 },
  creditsCharged: 0.5,
  creditsChargedExact: "0.5",
  providerCostUsdExact: "0.005",
  creditUnit: "service_credit",
  cashbackUsdExact: null,
  remainingCredits: 10,
  remainingCreditsExact: "10",
};

function dataFrames(frames) {
  return frames.filter((frame) => frame.startsWith("data: {")).map((frame) => JSON.parse(frame.slice(6)));
}

test("OpenAI request maps roles, content parts, tool turns and token aliases", () => {
  const parsed = parseOpenAiRequest({
    model: "gpt-6-astra",
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 100,
    max_completion_tokens: 200,
    temperature: 0.2,
    tools: [{ type: "function", function: { name: "read" } }],
    messages: [
      { role: "developer", content: "rules" },
      { role: "user", content: [{ type: "text", text: "a" }, { type: "image_url", image_url: {} }] },
      { role: "assistant", content: null, tool_calls: [{ function: { name: "read", arguments: "{\"p\":1}" } }] },
      { role: "tool", content: "file body" },
      { role: "assistant", content: "" },
    ],
  });
  assert.deepEqual(parsed.request.messages, [
    { role: "system", content: "rules" },
    { role: "user", content: "a\n[image_url omitted]" },
    { role: "assistant", content: "[tool call read: {\"p\":1}]" },
    { role: "user", content: "[tool result]\nfile body" },
  ]);
  assert.equal(parsed.request.requestedMaxOutputTokens, 200);
  assert.equal(parsed.request.stream, true);
  assert.equal(parsed.request.includeStreamUsage, true);
});

test("OpenAI request rejects missing model, unknown roles and system-only input", () => {
  assert.ok("error" in parseOpenAiRequest({ messages: [{ role: "user", content: "hi" }] }));
  assert.ok("error" in parseOpenAiRequest({ model: "m", messages: [{ role: "robot", content: "hi" }] }));
  assert.ok("error" in parseOpenAiRequest({ model: "m", messages: [{ role: "system", content: "hi" }] }));
  assert.ok("error" in parseOpenAiRequest({ model: "m" }));
});

test("Anthropic request maps system blocks and content blocks", () => {
  const parsed = parseAnthropicRequest({
    model: "claude-opus-5",
    max_tokens: 64000,
    system: [{ type: "text", text: "one" }, { type: "text", text: "two" }],
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", name: "Read", input: { p: 1 } }] },
      { role: "user", content: [{ type: "tool_result", content: [{ type: "text", text: "body" }] }] },
    ],
  });
  assert.deepEqual(parsed.request.messages, [
    { role: "system", content: "one\ntwo" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "ok\n[tool call Read: {\"p\":1}]" },
    { role: "user", content: "[tool result]\nbody" },
  ]);
  assert.equal(parsed.request.requestedMaxOutputTokens, 64000);
  assert.equal(parsed.request.stream, false);
  assert.ok("error" in parseAnthropicRequest({ model: "m", messages: [{ role: "system", content: "x" }] }));
});

test("output tokens are clamped to the model bound instead of rejected", () => {
  assert.equal(clampMaxOutputTokens(64000, 8192), 8192);
  assert.equal(clampMaxOutputTokens(undefined, 8192), 4096);
  assert.equal(clampMaxOutputTokens(undefined, 2048), 2048);
  assert.equal(clampMaxOutputTokens(16, 8192), 16);
  assert.equal(flattenContent(undefined), "");
});

test("OpenAI responses carry the completion, usage and exact receipt", () => {
  const body = openAiCompletion(output, "chatcmpl-1", 1, "gpt-6-astra");
  assert.equal(body.choices[0].message.content, output.content);
  assert.deepEqual(body.usage, { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 });
  assert.equal(body.accred.creditsChargedExact, "0.5");

  const frames = openAiStreamFrames(output, "chatcmpl-1", 1, "gpt-6-astra", true);
  assert.equal(frames.at(-1), "data: [DONE]\n\n");
  const chunks = dataFrames(frames);
  assert.equal(chunks[0].choices[0].delta.role, "assistant");
  assert.equal(chunks.map((chunk) => chunk.choices[0]?.delta?.content ?? "").join(""), output.content);
  assert.equal(chunks.at(-2).choices[0].finish_reason, "stop");
  assert.equal(chunks.at(-1).usage.total_tokens, 46);
  assert.equal(dataFrames(openAiStreamFrames(output, "c", 1, "m", false)).at(-1).choices[0].finish_reason, "stop");
});

test("Anthropic responses follow the Messages event order", () => {
  const body = anthropicMessage(output, "msg_1", "claude-opus-5");
  assert.equal(body.content[0].text, output.content);
  assert.deepEqual(body.usage, { input_tokens: 12, output_tokens: 34 });

  const frames = [anthropicStreamStart("msg_1", "claude-opus-5"), ...anthropicStreamFrames(output)];
  const events = frames.map((frame) => frame.split("\n")[0].replace("event: ", ""));
  assert.equal(events[0], "message_start");
  assert.equal(events[1], "content_block_start");
  assert.deepEqual(events.slice(-3), ["content_block_stop", "message_delta", "message_stop"]);
  const text = frames.filter((frame) => frame.startsWith("event: content_block_delta"))
    .map((frame) => JSON.parse(frame.split("\n")[1].slice(6)).delta.text).join("");
  assert.equal(text, output.content);
});

test("errors use each client's error envelope", () => {
  assert.deepEqual(compatErrorBody("openai", 402, "no credits"), {
    error: { message: "no credits", type: "insufficient_quota", code: "insufficient_quota" },
  });
  assert.deepEqual(compatErrorBody("anthropic", 429, "slow down"), {
    type: "error",
    error: { type: "rate_limit_error", message: "slow down" },
  });
  assert.equal(compatErrorBody("openai", 503, "down").error.type, "api_error");
  assert.ok(compatStreamError("anthropic", 503, "down").startsWith("event: error\n"));
  assert.ok(compatStreamError("openai", 503, "down").startsWith("data: {\"error\""));
});
