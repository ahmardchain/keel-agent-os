#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import {
  createRiskReceipt,
  DEFAULT_POLICY,
  evaluateRisk,
  verifyRiskReceipt,
} from "../agent/keel/scripts/evaluate-risk.mjs";

const BASE_ACCOUNT = {
  equity: 4860.2,
  dayPnlPercent: -2.1,
  consecutiveLosses: 2,
  exposureBySymbol: {
    SOLUSDT: 389,
    BTCUSDT: 580,
    ETHUSDT: 250,
    BNBUSDT: 120,
  },
};

const BASE_MARKET = {
  lastPrice: 143.18,
  fiveMinuteMovePercent: 0.62,
  spreadBps: 1.7,
  bidDepthOnePercent: 2840000,
};

export const JUDGE_CASES = [
  {
    number: "01",
    name: "Planned entry",
    expected: "APPROVE",
    input: {
      intent: { symbol: "BTCUSDT", side: "BUY", quoteAmount: 180 },
      account: {
        ...BASE_ACCOUNT,
        dayPnlPercent: -0.4,
        consecutiveLosses: 0,
        exposureBySymbol: { ...BASE_ACCOUNT.exposureBySymbol, BTCUSDT: 100 },
      },
      market: {
        lastPrice: 111240,
        fiveMinuteMovePercent: 0.18,
        spreadBps: 1.2,
        bidDepthOnePercent: 8420000,
      },
      policy: DEFAULT_POLICY,
    },
  },
  {
    number: "02",
    name: "FOMO sizing",
    expected: "RESIZE",
    input: {
      intent: { symbol: "SOLUSDT", side: "BUY", quoteAmount: 1200 },
      account: BASE_ACCOUNT,
      market: BASE_MARKET,
      policy: DEFAULT_POLICY,
    },
  },
  {
    number: "03",
    name: "Revenge trade",
    expected: "BLOCK",
    input: {
      intent: { symbol: "ETHUSDT", side: "BUY", quoteAmount: 250 },
      account: {
        ...BASE_ACCOUNT,
        dayPnlPercent: -3.2,
        consecutiveLosses: 3,
      },
      market: {
        lastPrice: 4320,
        fiveMinuteMovePercent: -0.31,
        spreadBps: 2.4,
        bidDepthOnePercent: 5160000,
      },
      policy: DEFAULT_POLICY,
    },
  },
];

export function runJudgeCases() {
  const rows = JUDGE_CASES.map((scenario) => {
    const evaluation = evaluateRisk(scenario.input);
    const receipt = createRiskReceipt(scenario.input, evaluation, {
      evaluatedAt: "2026-09-05T15:30:00.000Z",
      observedAt: "2026-09-05T15:29:58.000Z",
      evidenceMode: "deterministic-judge-fixture",
    });
    return {
      ...scenario,
      evaluation,
      receipt,
      passed: evaluation.decision === scenario.expected && verifyRiskReceipt(receipt),
    };
  });

  return rows;
}

function main() {
  const rows = runJudgeCases();
  process.stdout.write("Keel deterministic judge cases\n\n");
  for (const row of rows) {
    process.stdout.write(
      `${row.number}  ${row.name.padEnd(16)} ${row.evaluation.decision.padEnd(7)} ` +
        `requested ${row.evaluation.requestedQuoteAmount} → policy ${row.evaluation.approvedQuoteAmount}  ` +
        `${row.receipt.receiptId}\n`,
    );
  }

  const passed = rows.every((row) => row.passed);
  process.stdout.write(`\n${passed ? "PASS" : "FAIL"}  ${rows.filter((row) => row.passed).length}/${rows.length} decisions and receipt fingerprints verified\n`);
  if (!passed) process.exitCode = 1;
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();

