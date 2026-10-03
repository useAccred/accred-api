import assert from "node:assert/strict";
import test from "node:test";
import { fetchCanonicalXTweet } from "./x-bot-x-api.ts";

const config = {
  bearerToken: "local-test-bearer",
  serviceToken: "unused-test-service-token",
  userId: "42",
  postingEnabled: false,
  missing: [],
  configured: true,
};

test("canonical tweet reader fetches author from official API, not caller payload", async () => {
  const requests = [];
  const canonical = await fetchCanonicalXTweet("123", config, async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({
      data: { id: "123", author_id: "x-canonical-author", text: "@bot balance" },
    }), { status: 200 });
  });
  assert.equal(canonical.authorId, "x-canonical-author");
  assert.equal(canonical.text, "@bot balance");
  assert.match(requests[0].url, /api\.x\.com\/2\/tweets\/123/);
  assert.equal(requests[0].options.method ?? "GET", "GET");
  assert.equal(requests[0].options.headers.authorization, "Bearer local-test-bearer");
});

test("canonical tweet reader does not make network calls for invalid IDs", async () => {
  let calls = 0;
  await assert.rejects(
    () => fetchCanonicalXTweet("forged-id", config, async () => {
      calls += 1;
      return new Response("{}");
    }),
    /Invalid X tweet ID/,
  );
  assert.equal(calls, 0);
});