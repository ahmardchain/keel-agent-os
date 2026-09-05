#!/usr/bin/env node

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export const DEFAULT_POLICY = Object.freeze({
  maxAssetPercent: 15,
  maxDailyLossPercent: 3,
  lossStreakCooldown: 3,
  maxFiveMinuteMovePercent: 4,
  maxSpreadBps: 12,
  wideSpreadHaircutPercent: 50,
  quoteStep: 10,
  minQuoteAmount: 10,
});

const DEMO_INPUT = Object.freeze({
  intent: { symbol: "SOLUSDT", side: "BUY", quoteAmount: 1200 },
  account: {
    equity: 4860.2,
    dayPnlPercent: -2.1,
    consecutiveLosses: 2,
    exposureBySymbol: { SOLUSDT: 389 },
  },
  market: {
    lastPrice: 143.18,
    fiveMinuteMovePercent: 0.62,
    spreadBps: 1.7,
    bidDepthOnePercent: 2840000,
  },
  policy: DEFAULT_POLICY,
});

function finite(value, name, minimum = -Infinity) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    const suffix = minimum !== -Infinity ? ` >= ${minimum}` : "";
    throw new TypeError(`${name} must be a finite number${suffix}`);
  }
  return value;
}

function normalize(input) {
  if (!input || typeof input !== "object") throw new TypeError("input must be an object");

  const symbol = String(input.intent?.symbol ?? "").trim().toUpperCase();
  const side = String(input.intent?.side ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) throw new TypeError("intent.symbol is invalid");
  if (side !== "BUY") throw new TypeError("Keel MVP accepts BUY intents only");

  const policy = { ...DEFAULT_POLICY, ...(input.policy ?? {}) };
  const normalizedPolicy = {
    maxAssetPercent: finite(policy.maxAssetPercent, "policy.maxAssetPercent", 0.01),
    maxDailyLossPercent: finite(policy.maxDailyLossPercent, "policy.maxDailyLossPercent", 0.01),
    lossStreakCooldown: finite(policy.lossStreakCooldown, "policy.lossStreakCooldown", 1),
    maxFiveMinuteMovePercent: finite(
      policy.maxFiveMinuteMovePercent,
      "policy.maxFiveMinuteMovePercent",
      0.01,
    ),
    maxSpreadBps: finite(policy.maxSpreadBps, "policy.maxSpreadBps", 0.01),
    wideSpreadHaircutPercent: finite(
      policy.wideSpreadHaircutPercent,
      "policy.wideSpreadHaircutPercent",
      0,
    ),
    quoteStep: finite(policy.quoteStep, "policy.quoteStep", 0.01),
    minQuoteAmount: finite(policy.minQuoteAmount, "policy.minQuoteAmount", 0.01),
  };

  if (normalizedPolicy.maxAssetPercent > 100) {
    throw new TypeError("policy.maxAssetPercent must be <= 100");
  }
  if (normalizedPolicy.wideSpreadHaircutPercent > 100) {
    throw new TypeError("policy.wideSpreadHaircutPercent must be <= 100");
  }

  const exposureBySymbol = input.account?.exposureBySymbol ?? {};
  if (!exposureBySymbol || typeof exposureBySymbol !== "object") {
    throw new TypeError("account.exposureBySymbol must be an object");
  }

  return {
    intent: {
      symbol,
      side,
      quoteAmount: finite(input.intent?.quoteAmount, "intent.quoteAmount", 0.01),
    },
    account: {
      equity: finite(input.account?.equity, "account.equity", 0.01),
      dayPnlPercent: finite(input.account?.dayPnlPercent, "account.dayPnlPercent"),
      consecutiveLosses: finite(input.account?.consecutiveLosses, "account.consecutiveLosses", 0),
      exposureBySymbol,
    },
    market: {
      lastPrice: finite(input.market?.lastPrice, "market.lastPrice", 0.00000001),
      fiveMinuteMovePercent: finite(
        input.market?.fiveMinuteMovePercent,
        "market.fiveMinuteMovePercent",
      ),
      spreadBps: finite(input.market?.spreadBps, "market.spreadBps", 0),
      bidDepthOnePercent: finite(
        input.market?.bidDepthOnePercent,
        "market.bidDepthOnePercent",
        0,
      ),
    },
    policy: normalizedPolicy,
  };
}

function floorToStep(value, step) {
  return Math.floor((value + Number.EPSILON) / step) * step;
}

export function evaluateRisk(rawInput) {
  const { intent, account, market, policy } = normalize(rawInput);
  const currentExposure = finite(
    Number(account.exposureBySymbol[intent.symbol] ?? 0),
    `account.exposureBySymbol.${intent.symbol}`,
    0,
  );
  const positionCap = account.equity * (policy.maxAssetPercent / 100);
  const remainingCapacity = Math.max(0, positionCap - currentExposure);
  const wideSpread = market.spreadBps > policy.maxSpreadBps;
  const spreadAdjustedRequest = wideSpread
    ? intent.quoteAmount * (1 - policy.wideSpreadHaircutPercent / 100)
    : intent.quoteAmount;
  const sizeCeiling = Math.min(remainingCapacity, spreadAdjustedRequest);
  const sizedQuoteAmount = Math.max(0, floorToStep(sizeCeiling, policy.quoteStep));

  const dailyLimitHit = account.dayPnlPercent <= -policy.maxDailyLossPercent;
  const cooldownHit = account.consecutiveLosses >= policy.lossStreakCooldown;
  const velocityHit =
    Math.abs(market.fiveMinuteMovePercent) >= policy.maxFiveMinuteMovePercent;
  const belowMinimum = sizedQuoteAmount < policy.minQuoteAmount;

  let decision = "APPROVE";
  let primaryCode = "WITHIN_POLICY";
  if (dailyLimitHit || belowMinimum) {
    decision = "BLOCK";
    primaryCode = dailyLimitHit ? "DAILY_LOSS_LIMIT" : "NO_RISK_CAPACITY";
  } else if (cooldownHit || velocityHit) {
    decision = "PAUSE";
    primaryCode = cooldownHit ? "LOSS_STREAK_COOLDOWN" : "MARKET_VELOCITY";
  } else if (sizedQuoteAmount < intent.quoteAmount) {
    decision = "RESIZE";
    primaryCode = wideSpread ? "EXECUTION_QUALITY" : "POSITION_CONCENTRATION";
  }

  const executable = decision === "APPROVE" || decision === "RESIZE";
  const approvedQuoteAmount = executable ? Number(sizedQuoteAmount.toFixed(8)) : 0;

  return {
    version: "keel-risk-v1",
    decision,
    primaryCode,
    requestedQuoteAmount: intent.quoteAmount,
    approvedQuoteAmount,
    estimatedQuantity: Number((approvedQuoteAmount / market.lastPrice).toFixed(8)),
    symbol: intent.symbol,
    side: intent.side,
    execution: {
      allowedToPrepare: executable,
      requiresFreshConfirmation: executable,
      sent: false,
    },
    metrics: {
      currentExposure: Number(currentExposure.toFixed(8)),
      positionCap: Number(positionCap.toFixed(8)),
      remainingCapacity: Number(remainingCapacity.toFixed(8)),
      dayPnlPercent: account.dayPnlPercent,
      consecutiveLosses: account.consecutiveLosses,
      fiveMinuteMovePercent: market.fiveMinuteMovePercent,
      spreadBps: market.spreadBps,
      bidDepthOnePercent: market.bidDepthOnePercent,
    },
    reasons: [
      {
        code: "DAILY_LOSS",
        status: dailyLimitHit ? "STOP" : "PASS",
        detail: `${account.dayPnlPercent}% vs -${policy.maxDailyLossPercent}% limit`,
      },
      {
        code: "LOSS_STREAK",
        status: cooldownHit ? "STOP" : "PASS",
        detail: `${account.consecutiveLosses} vs ${policy.lossStreakCooldown} cooldown trigger`,
      },
      {
        code: "POSITION_CONCENTRATION",
        status: remainingCapacity < intent.quoteAmount ? "WARN" : "PASS",
        detail: `${currentExposure} current / ${Number(positionCap.toFixed(2))} cap`,
      },
      {
        code: "MARKET_VELOCITY",
        status: velocityHit ? "STOP" : "PASS",
        detail: `${market.fiveMinuteMovePercent}% over 5m vs ±${policy.maxFiveMinuteMovePercent}%`,
      },
      {
        code: "EXECUTION_QUALITY",
        status: wideSpread ? "WARN" : "PASS",
        detail: `${market.spreadBps} bps spread vs ${policy.maxSpreadBps} bps limit`,
      },
    ],
    policySnapshot: policy,
    evaluatedAt: new Date().toISOString(),
  };
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(",")}}`;
}

function digestPayload(payload) {
  return createHash("sha256").update(canonicalize(payload)).digest("hex");
}

export function createRiskReceipt(rawInput, evaluation = evaluateRisk(rawInput), metadata = {}) {
  const normalized = normalize(rawInput);
  const evaluatedAt = metadata.evaluatedAt ?? evaluation.evaluatedAt;
  const payload = {
    evaluatedAt,
    evidenceMode: metadata.evidenceMode ?? "provided-agent-evidence",
    intent: normalized.intent,
    account: normalized.account,
    market: {
      ...normalized.market,
      observedAt: metadata.observedAt ?? evaluatedAt,
    },
    decision: {
      version: evaluation.version,
      decision: evaluation.decision,
      primaryCode: evaluation.primaryCode,
      requestedQuoteAmount: evaluation.requestedQuoteAmount,
      approvedQuoteAmount: evaluation.approvedQuoteAmount,
      estimatedQuantity: evaluation.estimatedQuantity,
      symbol: evaluation.symbol,
      side: evaluation.side,
      execution: evaluation.execution,
      metrics: evaluation.metrics,
      reasons: evaluation.reasons,
    },
    policy: normalized.policy,
  };
  const digest = digestPayload(payload);

  return {
    schema: "keel-risk-receipt-v1",
    receiptId: `keel_${digest.slice(0, 16)}`,
    payload,
    integrity: {
      algorithm: "SHA-256",
      canonicalization: "sorted-json-v1",
      digest,
    },
  };
}

export function verifyRiskReceipt(receipt) {
  if (
    !receipt ||
    receipt.schema !== "keel-risk-receipt-v1" ||
    receipt.integrity?.algorithm !== "SHA-256" ||
    typeof receipt.integrity?.digest !== "string"
  ) {
    return false;
  }

  return digestPayload(receipt.payload) === receipt.integrity.digest;
}

async function readStdin() {
  let body = "";
  for await (const chunk of process.stdin) body += chunk;
  return body;
}

async function main() {
  try {
    if (process.argv.includes("--verify-receipt")) {
      const receipt = JSON.parse(await readStdin());
      const valid = verifyRiskReceipt(receipt);
      process.stdout.write(
        `${JSON.stringify({ valid, receiptId: receipt?.receiptId ?? null }, null, 2)}\n`,
      );
      if (!valid) process.exitCode = 1;
      return;
    }

    const rawInput = process.argv.includes("--demo")
      ? DEMO_INPUT
      : JSON.parse(await readStdin());
    const evaluation = evaluateRisk(rawInput);
    const receipt = createRiskReceipt(rawInput, evaluation);
    process.stdout.write(`${JSON.stringify({ ...evaluation, receipt }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ error: "INVALID_EVIDENCE", detail: error instanceof Error ? error.message : String(error) })}\n`,
    );
    process.exitCode = 1;
  }
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
