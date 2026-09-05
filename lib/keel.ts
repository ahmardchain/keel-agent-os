export type Decision = "APPROVE" | "RESIZE" | "PAUSE" | "BLOCK";

export type EvidenceSource = "live" | "fallback" | "judge";

export type MarketSnapshot = {
  symbol: string;
  lastPrice: number;
  priceChangePercent: number;
  fiveMinuteMove: number;
  spreadBps: number;
  bidDepthOnePercent: number;
  askDepthOnePercent: number;
  highPrice: number;
  lowPrice: number;
  closes: number[];
  source: EvidenceSource;
  timestamp: string;
};

export type AccountSnapshot = {
  equity: number;
  available: number;
  dayPnl: number;
  lossStreak: number;
  existingExposure: Record<string, number>;
};

export type Policy = {
  maxAssetPercent: number;
  maxDailyLossPercent: number;
  lossStreakCooldown: number;
  maxFiveMinuteMovePercent: number;
  maxSpreadBps: number;
  wideSpreadHaircutPercent: number;
  quoteStep: number;
  minQuoteAmount: number;
};

export type Analysis = {
  version: "keel-risk-v1";
  decision: Decision;
  primaryCode:
    | "WITHIN_POLICY"
    | "DAILY_LOSS_LIMIT"
    | "NO_RISK_CAPACITY"
    | "LOSS_STREAK_COOLDOWN"
    | "MARKET_VELOCITY"
    | "EXECUTION_QUALITY"
    | "POSITION_CONCENTRATION";
  requested: number;
  approved: number;
  symbol: string;
  side: "BUY";
  quantity: number;
  reasons: Array<{
    code: string;
    label: string;
    detail: string;
    tone: "pass" | "warn" | "stop";
  }>;
  execution: {
    allowedToPrepare: boolean;
    requiresFreshConfirmation: boolean;
    sent: false;
  };
  policySnapshot: Policy;
  evaluatedAt: string;
};

export type RiskReceipt = {
  schema: "keel-risk-receipt-v1";
  receiptId: string;
  payload: {
    evaluatedAt: string;
    evidenceMode: "live-public-market" | "fallback-market" | "deterministic-judge-fixture";
    intent: {
      raw: string;
      symbol: string;
      side: "BUY";
      requestedQuoteAmount: number;
    };
    account: {
      equity: number;
      available: number;
      dayPnlPercent: number;
      consecutiveLosses: number;
      exposureBySymbol: Record<string, number>;
    };
    market: Omit<MarketSnapshot, "closes">;
    decision: Omit<Analysis, "policySnapshot" | "evaluatedAt">;
    policy: Policy;
  };
  integrity: {
    algorithm: "SHA-256";
    canonicalization: "sorted-json-v1";
    digest: string;
  };
};

export const DEFAULT_POLICY: Policy = Object.freeze({
  maxAssetPercent: 15,
  maxDailyLossPercent: 3,
  lossStreakCooldown: 3,
  maxFiveMinuteMovePercent: 4,
  maxSpreadBps: 12,
  wideSpreadHaircutPercent: 50,
  quoteStep: 10,
  minQuoteAmount: 10,
});

export function extractIntent(input: string) {
  const upper = input.toUpperCase();
  const asset = upper.match(/\b(BTC|ETH|BNB|SOL|XRP|DOGE|ADA)(?:USDT)?\b/)?.[1] ?? "SOL";
  const amountMatch = input.match(/\$\s*([\d,.]+)|([\d,.]+)\s*(?:USDT|USD)\b/i);
  const rawAmount = amountMatch?.[1] ?? amountMatch?.[2] ?? "1200";
  const amount = Number(rawAmount.replaceAll(",", ""));

  return {
    symbol: `${asset}USDT`,
    amount: Number.isFinite(amount) && amount > 0 ? amount : 1200,
  };
}

function floorToStep(value: number, step: number) {
  return Math.floor((value + Number.EPSILON) / step) * step;
}

function money(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

export function evaluateRisk(
  input: string,
  account: AccountSnapshot,
  market: MarketSnapshot,
  policy: Policy = DEFAULT_POLICY,
): Analysis {
  const { symbol, amount } = extractIntent(input);
  const currentExposure = account.existingExposure[symbol] ?? 0;
  const positionCap = account.equity * (policy.maxAssetPercent / 100);
  const remainingCapacity = Math.max(0, positionCap - currentExposure);
  const wideSpread = market.spreadBps > policy.maxSpreadBps;
  const spreadAdjustedRequest = wideSpread
    ? amount * (1 - policy.wideSpreadHaircutPercent / 100)
    : amount;
  const sizedAmount = Math.max(
    0,
    floorToStep(Math.min(remainingCapacity, spreadAdjustedRequest), policy.quoteStep),
  );

  const dailyLimitHit = account.dayPnl <= -policy.maxDailyLossPercent;
  const cooldownHit = account.lossStreak >= policy.lossStreakCooldown;
  const velocityHit = Math.abs(market.fiveMinuteMove) >= policy.maxFiveMinuteMovePercent;
  const belowMinimum = sizedAmount < policy.minQuoteAmount;

  let decision: Decision = "APPROVE";
  let primaryCode: Analysis["primaryCode"] = "WITHIN_POLICY";

  if (dailyLimitHit || belowMinimum) {
    decision = "BLOCK";
    primaryCode = dailyLimitHit ? "DAILY_LOSS_LIMIT" : "NO_RISK_CAPACITY";
  } else if (cooldownHit || velocityHit) {
    decision = "PAUSE";
    primaryCode = cooldownHit ? "LOSS_STREAK_COOLDOWN" : "MARKET_VELOCITY";
  } else if (sizedAmount < amount) {
    decision = "RESIZE";
    primaryCode = wideSpread ? "EXECUTION_QUALITY" : "POSITION_CONCENTRATION";
  }

  const executable = decision === "APPROVE" || decision === "RESIZE";
  const approved = executable ? Number(sizedAmount.toFixed(8)) : 0;

  return {
    version: "keel-risk-v1",
    decision,
    primaryCode,
    requested: amount,
    approved,
    symbol,
    side: "BUY",
    quantity: market.lastPrice > 0 ? approved / market.lastPrice : 0,
    reasons: [
      {
        code: "DAILY_LOSS",
        label: "Daily loss",
        detail: `${account.dayPnl.toFixed(1)}% of −${policy.maxDailyLossPercent.toFixed(1)}% limit`,
        tone: dailyLimitHit ? "stop" : "pass",
      },
      {
        code: "LOSS_STREAK",
        label: "Loss streak",
        detail: `${account.lossStreak} of ${policy.lossStreakCooldown} cooldown trigger`,
        tone: cooldownHit ? "stop" : "pass",
      },
      {
        code: "POSITION_CONCENTRATION",
        label: "Position concentration",
        detail: `${money(currentExposure)} already in ${symbol.replace("USDT", "")} · ${policy.maxAssetPercent}% cap`,
        tone: remainingCapacity < amount ? "warn" : "pass",
      },
      {
        code: "MARKET_VELOCITY",
        label: "Market velocity",
        detail: `${market.fiveMinuteMove >= 0 ? "+" : ""}${market.fiveMinuteMove.toFixed(2)}% over 5m`,
        tone: velocityHit ? "stop" : "pass",
      },
      {
        code: "EXECUTION_QUALITY",
        label: "Execution quality",
        detail: `${market.spreadBps.toFixed(1)} bps spread`,
        tone: wideSpread ? "warn" : "pass",
      },
    ],
    execution: {
      allowedToPrepare: executable,
      requiresFreshConfirmation: executable,
      sent: false,
    },
    policySnapshot: policy,
    evaluatedAt: new Date().toISOString(),
  };
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(",")}}`;
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createRiskReceipt(args: {
  rawIntent: string;
  account: AccountSnapshot;
  market: MarketSnapshot;
  analysis: Analysis;
}): Promise<RiskReceipt> {
  const { rawIntent, account, market, analysis } = args;
  const marketEvidence: Omit<MarketSnapshot, "closes"> = {
    symbol: market.symbol,
    lastPrice: market.lastPrice,
    priceChangePercent: market.priceChangePercent,
    fiveMinuteMove: market.fiveMinuteMove,
    spreadBps: market.spreadBps,
    bidDepthOnePercent: market.bidDepthOnePercent,
    askDepthOnePercent: market.askDepthOnePercent,
    highPrice: market.highPrice,
    lowPrice: market.lowPrice,
    source: market.source,
    timestamp: market.timestamp,
  };
  const evidenceMode: RiskReceipt["payload"]["evidenceMode"] =
    market.source === "live"
      ? "live-public-market"
      : market.source === "judge"
        ? "deterministic-judge-fixture"
        : "fallback-market";

  const payload: RiskReceipt["payload"] = {
    evaluatedAt: analysis.evaluatedAt,
    evidenceMode,
    intent: {
      raw: rawIntent,
      symbol: analysis.symbol,
      side: analysis.side,
      requestedQuoteAmount: analysis.requested,
    },
    account: {
      equity: account.equity,
      available: account.available,
      dayPnlPercent: account.dayPnl,
      consecutiveLosses: account.lossStreak,
      exposureBySymbol: account.existingExposure,
    },
    market: marketEvidence,
    decision: {
      version: analysis.version,
      decision: analysis.decision,
      primaryCode: analysis.primaryCode,
      requested: analysis.requested,
      approved: analysis.approved,
      symbol: analysis.symbol,
      side: analysis.side,
      quantity: analysis.quantity,
      reasons: analysis.reasons,
      execution: analysis.execution,
    },
    policy: analysis.policySnapshot,
  };

  const digest = await sha256(canonicalize(payload));

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

export async function verifyRiskReceipt(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<RiskReceipt>;
  if (
    receipt.schema !== "keel-risk-receipt-v1" ||
    !receipt.payload ||
    receipt.integrity?.algorithm !== "SHA-256" ||
    receipt.integrity.canonicalization !== "sorted-json-v1" ||
    typeof receipt.integrity.digest !== "string"
  ) {
    return false;
  }

  return (await sha256(canonicalize(receipt.payload))) === receipt.integrity.digest;
}
