import assert from "node:assert/strict";
import test from "node:test";
import {
  microcreditsForUsd,
  microcreditsToDecimal,
  parseDecimal,
  providerCostUsdForUsage,
  reserveMicrocredits,
} from "./customer-models.ts";
import { vaultUnitsToCreditsDecimal } from "./customer-gateway.ts";

const openai = {
  provider: "openai",
  inputCostUsdPerMillion: "0.1234567",
  outputCostUsdPerMillion: "0.2345678",
  cachedInputCostUsdPerMillion: "0.01234567",
  cacheWrite5mCostUsdPerMillion: null,
  cacheWrite1hCostUsdPerMillion: null,
  cacheReadCostUsdPerMillion: null,
};

test("fractional provider rates charge exact cached and uncached input, then round positive cost up to a microcredit", () => {
  const cost = providerCostUsdForUsage(openai, {
    inputTokens: 3,
    outputTokens: 4,
    cachedInputTokens: 2,
    thoughtsTokens: 1,
  });
  assert.equal(cost, "0.00000108641924");
  const charge = microcreditsForUsd(cost);
  assert.equal(charge, 109n);
  assert.equal(microcreditsToDecimal(charge), "0.000109");
  assert.equal(vaultUnitsToCreditsDecimal(charge * 1_000_000_000_000n), "0.000109");
});

test("worst-case fractional reservation uses bigint rates and rounds up to microcredits", () => {
  const input = parseDecimal("0.1234567");
  const output = parseDecimal("0.2345678");
  assert.ok(input && output);
  assert.equal(reserveMicrocredits(input, output, 2, 1), 49n);
});

test("cache category rates are applied independently and missing provider detail is not treated as zero", () => {
  const anthropic = {
    provider: "anthropic",
    inputCostUsdPerMillion: "5",
    outputCostUsdPerMillion: "25",
    cachedInputCostUsdPerMillion: null,
    cacheReadCostUsdPerMillion: "0.5",
    cacheWrite5mCostUsdPerMillion: "6.25",
    cacheWrite1hCostUsdPerMillion: "10",
  };
  assert.equal(providerCostUsdForUsage(anthropic, {
    inputTokens: 100,
    outputTokens: 2,
    cacheReadInputTokens: 20,
    cacheWrite5mTokens: 10,
    cacheWrite1hTokens: 5,
  }), "0.0004975");
  assert.equal(providerCostUsdForUsage(anthropic, {
    inputTokens: 100,
    outputTokens: 2,
  }), undefined);
  assert.equal(providerCostUsdForUsage(openai, {
    inputTokens: 3,
    outputTokens: 4,
    thoughtsTokens: 0,
  }), undefined);
});

test("OpenRouter cost receipts are priced from reported USD, not token-rate estimates", () => {
  assert.equal(providerCostUsdForUsage({ provider: "openrouter" }, {
    inputTokens: 1,
    outputTokens: 1,
    reportedCostUsd: "0.000000005",
  }), "0.000000005");
  assert.equal(microcreditsForUsd("0.000000005"), 1n);
  assert.equal(providerCostUsdForUsage({ provider: "openrouter" }, {
    inputTokens: 1,
    outputTokens: 1,
  }), undefined);
});