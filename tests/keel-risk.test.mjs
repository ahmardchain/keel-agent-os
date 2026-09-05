import assert from "node:assert/strict";
import test from "node:test";

import { evaluateRisk } from "../agent/keel/scripts/evaluate-risk.mjs";

function fixture(overrides = {}) {
  return {
    intent: { symbol: "SOLUSDT", side: "BUY", quoteAmount: 1200 },
    account: {
      equity: 4860.2,
      dayPnlPercent: -2.1,
      consecutiveLosses: 2,
      exposureBySymbol: { SOLUSDT: 389 },
      ...overrides.account,
    },
    market: {
      lastPrice: 143.18,
      fiveMinuteMovePercent: 0.62,
      spreadBps: 1.7,
      bidDepthOnePercent: 2840000,
      ...overrides.market,
    },
    policy: {
      maxAssetPercent: 15,
      maxDailyLossPercent: 3,
      lossStreakCooldown: 3,
      maxFiveMinuteMovePercent: 4,
      maxSpreadBps: 12,
      ...overrides.policy,
    },
    ...overrides.root,
  };
}

test("resizes a trade that exceeds the per-asset cap", () => {
  const result = evaluateRisk(fixture());
  assert.equal(result.decision, "RESIZE");
  assert.equal(result.primaryCode, "POSITION_CONCENTRATION");
  assert.equal(result.approvedQuoteAmount, 340);
  assert.equal(result.execution.sent, false);
});

test("blocks new exposure after the daily loss limit", () => {
  const result = evaluateRisk(fixture({ account: { dayPnlPercent: -3.2 } }));
  assert.equal(result.decision, "BLOCK");
  assert.equal(result.primaryCode, "DAILY_LOSS_LIMIT");
  assert.equal(result.approvedQuoteAmount, 0);
});

test("pauses during excessive five-minute velocity", () => {
  const result = evaluateRisk(fixture({ market: { fiveMinuteMovePercent: 4.4 } }));
  assert.equal(result.decision, "PAUSE");
  assert.equal(result.primaryCode, "MARKET_VELOCITY");
  assert.equal(result.execution.allowedToPrepare, false);
});

test("approves a small trade inside every limit", () => {
  const input = fixture({
    account: { exposureBySymbol: { SOLUSDT: 100 } },
    root: { intent: { symbol: "SOLUSDT", side: "BUY", quoteAmount: 200 } },
  });
  const result = evaluateRisk(input);
  assert.equal(result.decision, "APPROVE");
  assert.equal(result.approvedQuoteAmount, 200);
  assert.equal(result.execution.requiresFreshConfirmation, true);
});
