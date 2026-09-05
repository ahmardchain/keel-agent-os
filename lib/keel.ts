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

const SHA256_ROUNDS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
  0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
  0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
  0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
  0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

function rotateRight(value: number, amount: number) {
  return (value >>> amount) | (value << (32 - amount));
}

function sha256Fallback(value: string) {
  const bytes = new TextEncoder().encode(value);
  const byteLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(byteLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer);
  const bitLength = bytes.length * 8;
  view.setUint32(byteLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(byteLength - 4, bitLength >>> 0);

  const hash = new Uint32Array([
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19,
  ]);
  const words = new Uint32Array(64);

  for (let offset = 0; offset < byteLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const low = words[index - 15];
      const high = words[index - 2];
      const sigma0 = rotateRight(low, 7) ^ rotateRight(low, 18) ^ (low >>> 3);
      const sigma1 = rotateRight(high, 17) ^ rotateRight(high, 19) ^ (high >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choice + SHA256_ROUNDS[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  return Array.from(hash, (word) => word.toString(16).padStart(8, "0")).join("");
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return sha256Fallback(value);
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
