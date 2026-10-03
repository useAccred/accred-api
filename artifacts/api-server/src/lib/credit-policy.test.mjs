import test from "node:test";
import assert from "node:assert/strict";
import { formatUnits, isTxHash, parseDecimalAmount, validateQuoteAmounts } from "./credit-policy.ts";
import { cashbackAmountForQuote, chooseCashbackBps } from "./cashback-policy.ts";

test("credit amounts use exact decimal integer conversion", () => {
  assert.deepEqual(parseDecimalAmount("0.000001", 6), { units: 1n, normalized: "0.000001" });
  assert.deepEqual(parseDecimalAmount("12.34", 6), { units: 12_340_000n, normalized: "12.34" });
  assert.equal(parseDecimalAmount("0.0000001", 6), undefined);
  assert.equal(parseDecimalAmount("01", 18), undefined);
  assert.equal(parseDecimalAmount("0", 18), undefined);
  assert.equal(formatUnits(10_000_000n, 6), "10");
});

test("quote amounts and transaction hashes are validated per chain", () => {
  assert.equal(validateQuoteAmounts("1", "100", "1000000"), true);
  assert.equal(validateQuoteAmounts("1", "100", "0"), false);
  assert.equal(isTxHash(`0x${"a".repeat(64)}`, "robinhood"), true);
  assert.equal(isTxHash("a".repeat(64), "robinhood"), false);
  assert.equal(isTxHash("not-a-signature", "solana"), false);
});

test("cashback is a flat 10% on every swap, capped at one 10 USDG payout", () => {
  assert.equal(chooseCashbackBps(), 1000);
  assert.equal(cashbackAmountForQuote(1_000_000n, 1000), 100_000n);
  assert.equal(cashbackAmountForQuote(100_000_000n, 1000), 10_000_000n);
  assert.equal(cashbackAmountForQuote(500_000_000n, 1000), 10_000_000n);
  assert.equal(cashbackAmountForQuote(1_000_000n, 500), undefined);
  assert.equal(cashbackAmountForQuote(1n, 1000), undefined);
});