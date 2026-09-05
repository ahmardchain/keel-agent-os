"use client";

import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Download,
  FileCheck2,
  LockKeyhole,
  Radio,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createRiskReceipt,
  DEFAULT_POLICY,
  evaluateRisk,
  extractIntent,
  type AccountSnapshot,
  type Analysis,
  type Decision,
  type MarketSnapshot,
  type RiskReceipt,
} from "@/lib/keel";

const DEMO_ACCOUNT: AccountSnapshot = {
  equity: 4860.2,
  available: 1610.42,
  dayPnl: -2.1,
  lossStreak: 2,
  existingExposure: {
    SOLUSDT: 389,
    BTCUSDT: 580,
    ETHUSDT: 250,
    BNBUSDT: 120,
  },
};

const FALLBACK_PRICES: Record<string, number> = {
  BTCUSDT: 111240,
  ETHUSDT: 4320,
  BNBUSDT: 875,
  SOLUSDT: 143.18,
  XRPUSDT: 2.84,
  DOGEUSDT: 0.24,
  ADAUSDT: 0.91,
};

const FIXTURE_TIMESTAMP = "2026-09-05T15:00:00.000Z";

function fallbackMarket(symbol = "SOLUSDT", timestamp = FIXTURE_TIMESTAMP): MarketSnapshot {
  const lastPrice = FALLBACK_PRICES[symbol] ?? FALLBACK_PRICES.SOLUSDT;
  const factors = [0.972, 0.976, 0.974, 0.982, 0.979, 0.988, 0.986, 0.994, 0.991, 1];

  return {
    symbol,
    lastPrice,
    priceChangePercent: 2.84,
    fiveMinuteMove: 0.62,
    spreadBps: 1.7,
    bidDepthOnePercent: 2840000,
    askDepthOnePercent: 2510000,
    highPrice: lastPrice * 1.026,
    lowPrice: lastPrice * 0.961,
    closes: factors.map((factor) => lastPrice * factor),
    source: "fallback",
    timestamp,
  };
}

const INITIAL_MARKET = fallbackMarket();

type JudgeScenario = {
  id: "planned" | "fomo" | "revenge";
  number: string;
  cue: string;
  expected: "APPROVE" | "RESIZE" | "BLOCK";
  prompt: string;
  account: AccountSnapshot;
  market: MarketSnapshot;
};

const JUDGE_SCENARIOS: JudgeScenario[] = [
  {
    id: "planned",
    number: "01",
    cue: "Planned entry",
    expected: "APPROVE",
    prompt: "Buy 180 USDT of BTC within my plan",
    account: {
      ...DEMO_ACCOUNT,
      dayPnl: -0.4,
      lossStreak: 0,
      existingExposure: { ...DEMO_ACCOUNT.existingExposure, BTCUSDT: 100 },
    },
    market: {
      ...fallbackMarket("BTCUSDT"),
      priceChangePercent: 0.84,
      fiveMinuteMove: 0.18,
      spreadBps: 1.2,
      bidDepthOnePercent: 8420000,
      askDepthOnePercent: 7980000,
      source: "judge",
    },
  },
  {
    id: "fomo",
    number: "02",
    cue: "FOMO sizing",
    expected: "RESIZE",
    prompt: "Buy $1,200 of SOL because it is pumping",
    account: DEMO_ACCOUNT,
    market: {
      ...fallbackMarket("SOLUSDT"),
      source: "judge",
    },
  },
  {
    id: "revenge",
    number: "03",
    cue: "Revenge trade",
    expected: "BLOCK",
    prompt: "Buy 250 USDT of ETH. I need to win back today's losses",
    account: {
      ...DEMO_ACCOUNT,
      dayPnl: -3.2,
      lossStreak: 3,
    },
    market: {
      ...fallbackMarket("ETHUSDT"),
      priceChangePercent: -1.18,
      fiveMinuteMove: -0.31,
      spreadBps: 2.4,
      bidDepthOnePercent: 5160000,
      askDepthOnePercent: 4940000,
      source: "judge",
    },
  },
];

function money(value: number, digits = 2) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: digits,
  }).format(value);
}

function Sparkline({ values }: { values: number[] }) {
  const path = useMemo(() => {
    if (values.length < 2) return "";
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    return values
      .map((value, index) => {
        const x = (index / (values.length - 1)) * 220;
        const y = 58 - ((value - min) / range) * 48;
        return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [values]);

  const lastY = path ? Number(path.split(",").at(-1)) : 34;

  return (
    <svg className="sparkline" viewBox="0 0 220 68" role="img" aria-label="Recent market price movement">
      <path className="sparkline-grid" d="M0 12H220 M0 34H220 M0 56H220" />
      <path className="sparkline-path" d={path} />
      <circle className="sparkline-point" cx="220" cy={lastY} r="3" />
    </svg>
  );
}

export default function Home() {
  const [intent, setIntent] = useState(JUDGE_SCENARIOS[1].prompt);
  const [account, setAccount] = useState<AccountSnapshot>(DEMO_ACCOUNT);
  const [market, setMarket] = useState<MarketSnapshot>(INITIAL_MARKET);
  const [analysis, setAnalysis] = useState<Analysis>(() =>
    evaluateRisk(JUDGE_SCENARIOS[1].prompt, DEMO_ACCOUNT, INITIAL_MARKET),
  );
  const [activeScenarioId, setActiveScenarioId] = useState<JudgeScenario["id"] | null>(null);
  const [receipt, setReceipt] = useState<RiskReceipt | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "prepared">("idle");
  const [notice, setNotice] = useState("Collecting live Binance market evidence");
  const receiptSequence = useRef(0);

  const fetchMarket = useCallback(async (symbol: string) => {
    try {
      const response = await fetch(`/api/market?symbol=${encodeURIComponent(symbol)}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Market request failed");
      return (await response.json()) as MarketSnapshot;
    } catch {
      return fallbackMarket(symbol, new Date().toISOString());
    }
  }, []);

  async function commitCheck(
    nextIntent: string,
    nextAccount: AccountSnapshot,
    nextMarket: MarketSnapshot,
    nextNotice: string,
    sequence: number,
  ) {
    if (sequence !== receiptSequence.current) return;
    const nextAnalysis = evaluateRisk(nextIntent, nextAccount, nextMarket);

    setAccount(nextAccount);
    setMarket(nextMarket);
    setAnalysis(nextAnalysis);
    setStatus("ready");
    setNotice(nextNotice);
    setReceipt(null);

    const nextReceipt = await createRiskReceipt({
      rawIntent: nextIntent,
      account: nextAccount,
      market: nextMarket,
      analysis: nextAnalysis,
    });

    if (sequence === receiptSequence.current) setReceipt(nextReceipt);
  }

  useEffect(() => {
    let active = true;
    const sequence = ++receiptSequence.current;
    fetchMarket("SOLUSDT").then(async (snapshot) => {
      if (!active || sequence !== receiptSequence.current) return;
      const nextAnalysis = evaluateRisk(JUDGE_SCENARIOS[1].prompt, DEMO_ACCOUNT, snapshot);
      setMarket(snapshot);
      setAnalysis(nextAnalysis);
      setStatus("ready");
      setNotice("Simulation only · no order has been sent");

      const nextReceipt = await createRiskReceipt({
        rawIntent: JUDGE_SCENARIOS[1].prompt,
        account: DEMO_ACCOUNT,
        market: snapshot,
        analysis: nextAnalysis,
      });
      if (active && sequence === receiptSequence.current) setReceipt(nextReceipt);
    });

    return () => {
      active = false;
    };
  }, [fetchMarket]);

  async function runCheck() {
    const sequence = ++receiptSequence.current;
    setStatus("loading");
    setReceipt(null);
    setNotice("Agent is collecting market and policy evidence");

    const scenario = JUDGE_SCENARIOS.find((item) => item.id === activeScenarioId);
    if (scenario) {
      await commitCheck(
        intent,
        scenario.account,
        { ...scenario.market, timestamp: new Date().toISOString() },
        `${scenario.expected} reproduced from deterministic judge evidence`,
        sequence,
      );
      return;
    }

    const parsed = extractIntent(intent);
    const snapshot = await fetchMarket(parsed.symbol);
    await commitCheck(
      intent,
      DEMO_ACCOUNT,
      snapshot,
      "Simulation only · no order has been sent",
      sequence,
    );
  }

  async function selectLiveCheck() {
    const sequence = ++receiptSequence.current;
    setActiveScenarioId(null);
    setStatus("loading");
    setReceipt(null);
    setNotice("Refreshing public Binance market evidence");
    const parsed = extractIntent(intent);
    const snapshot = await fetchMarket(parsed.symbol);
    await commitCheck(
      intent,
      DEMO_ACCOUNT,
      snapshot,
      "Live check ready · demo account · no order sent",
      sequence,
    );
  }

  async function selectScenario(scenario: JudgeScenario) {
    const sequence = ++receiptSequence.current;
    setActiveScenarioId(scenario.id);
    setIntent(scenario.prompt);
    setStatus("loading");
    setReceipt(null);
    setNotice(`Loading judge case ${scenario.number}`);
    await commitCheck(
      scenario.prompt,
      scenario.account,
      { ...scenario.market, timestamp: new Date().toISOString() },
      `${scenario.expected} reproduced from deterministic judge evidence`,
      sequence,
    );
  }

  function prepareOrder() {
    setStatus("prepared");
    setNotice("Order prepared. Fresh Binance confirmation is still required before execution.");
  }

  function handleIntentChange(value: string) {
    receiptSequence.current += 1;
    setIntent(value);
    setActiveScenarioId(null);
    setReceipt(null);
    setStatus("idle");
    setNotice("Intent changed · run a new live check");
  }

  function reset() {
    receiptSequence.current += 1;
    setIntent(JUDGE_SCENARIOS[1].prompt);
    setActiveScenarioId(null);
    setAccount(DEMO_ACCOUNT);
    setAnalysis(evaluateRisk(JUDGE_SCENARIOS[1].prompt, DEMO_ACCOUNT, market));
    setStatus("ready");
    setReceipt(null);
    setNotice("Reset complete · run a new check to issue a receipt");
  }

  function downloadReceipt() {
    if (!receipt) return;
    const blob = new Blob([`${JSON.stringify(receipt, null, 2)}\n`], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${receipt.receiptId}-${analysis.symbol.toLowerCase()}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  const decisionCopy: Record<Decision, { title: string; text: string }> = {
    APPROVE: {
      title: "Within your rules",
      text: "The requested size passes every active policy.",
    },
    RESIZE: {
      title: "Reduce before execution",
      text: "The idea is tradable, but the requested size breaks your exposure limit.",
    },
    PAUSE: {
      title: "Wait for the market to settle",
      text: "A temporary protection rule is active. Keel will not prepare the order.",
    },
    BLOCK: {
      title: "Trading stopped by policy",
      text: "Your hard daily protection rule has stopped new exposure.",
    },
  };

  const display = decisionCopy[analysis.decision];
  const timestamp = new Date(market.timestamp).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
  const lossUsed = Math.max(0, -account.dayPnl);
  const dailyLossBuffer = Math.max(
    0,
    Math.round(((DEFAULT_POLICY.maxDailyLossPercent - lossUsed) / DEFAULT_POLICY.maxDailyLossPercent) * 100),
  );
  const sourceLabel =
    market.source === "live" ? "Live" : market.source === "judge" ? "Judge fixture" : "Fallback fixture";
  const activeScenario = JUDGE_SCENARIOS.find((scenario) => scenario.id === activeScenarioId);

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Keel home">
          <span className="brand-mark">K</span>
          <span>Keel</span>
        </a>
        <div className="topbar-meta">
          <span className="network-badge">
            <span className="status-dot" /> Binance Agent OS
          </span>
          <span className="session-label">
            {activeScenario ? `Judge case ${activeScenario.number}` : "Public market · Demo account"}
          </span>
        </div>
      </header>

      <div className="workspace" id="top">
        <aside className="risk-rail">
          <section className="account-block">
            <div className="eyebrow">Protected equity</div>
            <div className="equity-value">{money(account.equity)}</div>
            <div className="account-line">
              <span>Available</span>
              <strong>{money(account.available)}</strong>
            </div>
          </section>

          <section className="risk-meter" aria-label="Daily loss buffer">
            <div className="section-heading">
              <span>Daily loss buffer</span>
              <strong>{dailyLossBuffer}%</strong>
            </div>
            <div className="meter-track">
              <span style={{ width: `${dailyLossBuffer}%` }} />
            </div>
            <p>
              {account.dayPnl <= -DEFAULT_POLICY.maxDailyLossPercent
                ? "Daily stop reached. New exposure is blocked."
                : `${Math.max(0, DEFAULT_POLICY.maxDailyLossPercent - lossUsed).toFixed(1)}% remains before the hard stop.`}
            </p>
          </section>

          <section className="rules-block">
            <div className="section-heading">
              <span>Active rulebook</span>
              <span className="rule-count">04</span>
            </div>
            <ul className="rule-list">
              <li>
                <ShieldCheck size={16} />
                <span><strong>15%</strong> max per asset</span>
              </li>
              <li>
                <CircleDollarSign size={16} />
                <span><strong>3%</strong> daily loss cap</span>
              </li>
              <li>
                <Clock3 size={16} />
                <span>Pause after <strong>3 losses</strong></span>
              </li>
              <li>
                <Activity size={16} />
                <span>Reject above <strong>4% / 5m</strong></span>
              </li>
            </ul>
          </section>

          <div className="rail-footnote">
            <LockKeyhole size={15} />
            <span>Keel can prepare a policy-sized order. Only you can confirm execution.</span>
          </div>
        </aside>

        <section className="main-panel">
          <div className="command-section">
            <div className="section-kicker">Pre-trade check</div>
            <div className="command-box">
              <textarea
                value={intent}
                onChange={(event) => handleIntentChange(event.target.value)}
                aria-label="Describe the trade you want to make"
                rows={2}
              />
              <button
                className="run-button"
                type="button"
                onClick={runCheck}
                disabled={status === "loading"}
              >
                {status === "loading" ? "Checking…" : "Run check"}
                <ChevronRight size={18} />
              </button>
            </div>

            <div className="scenario-toolbar" aria-label="Evidence modes and judge scenarios">
              <button
                className={`live-check-button ${activeScenarioId === null ? "active" : ""}`}
                type="button"
                onClick={selectLiveCheck}
                aria-pressed={activeScenarioId === null}
              >
                <Radio size={14} />
                <span><strong>Live check</strong><small>Public market</small></span>
              </button>
              <div className="scenario-set">
                <span className="scenario-set-label">Judge mode</span>
                {JUDGE_SCENARIOS.map((scenario) => (
                  <button
                    key={scenario.id}
                    className={`scenario-button scenario-${scenario.expected.toLowerCase()} ${
                      activeScenarioId === scenario.id ? "active" : ""
                    }`}
                    type="button"
                    onClick={() => selectScenario(scenario)}
                    aria-pressed={activeScenarioId === scenario.id}
                  >
                    <span>{scenario.number}</span>
                    <strong>{scenario.cue}</strong>
                    <small>{scenario.expected}</small>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="market-strip">
            <div className="market-identity">
              <span className="asset-glyph">{analysis.symbol.slice(0, 1)}</span>
              <div>
                <strong>{analysis.symbol.replace("USDT", "")}</strong>
                <span>/ USDT</span>
              </div>
            </div>
            <div className="market-stat">
              <span>Last</span>
              <strong>{money(market.lastPrice)}</strong>
            </div>
            <div className="market-stat">
              <span>24h</span>
              <strong className={market.priceChangePercent >= 0 ? "positive" : "negative"}>
                {market.priceChangePercent >= 0 ? "+" : ""}{market.priceChangePercent.toFixed(2)}%
              </strong>
            </div>
            <div className="market-stat">
              <span>Spread</span>
              <strong>{market.spreadBps.toFixed(1)} bps</strong>
            </div>
            <Sparkline values={market.closes} />
            <div className="live-stamp">
              <span className={market.source === "live" ? "status-dot" : "status-dot muted-dot"} />
              {sourceLabel} · {timestamp} UTC
            </div>
          </div>

          <div className={`decision-card decision-${analysis.decision.toLowerCase()}`}>
            <div className="decision-header">
              <div>
                <div className="decision-label">
                  <span>{analysis.decision}</span> Risk decision · {analysis.primaryCode.replaceAll("_", " ")}
                </div>
                <h1>{display.title}</h1>
                <p>{display.text}</p>
              </div>
              <div className="size-change" aria-label="Requested and approved size">
                <span>Requested <strong>{money(analysis.requested, 0)}</strong></span>
                <ArrowUpRight size={20} />
                <span>Policy size <strong>{money(analysis.approved, 0)}</strong></span>
              </div>
            </div>

            <div className="decision-grid">
              <section className="evidence-panel">
                <div className="panel-title">
                  <span>Evidence</span>
                  <span>05 checks</span>
                </div>
                <div className="evidence-list">
                  {analysis.reasons.map((reason) => (
                    <div className="evidence-row" key={reason.code}>
                      <span className={`evidence-icon ${reason.tone}`}>
                        {reason.tone === "pass" ? <Check size={14} /> : <AlertTriangle size={14} />}
                      </span>
                      <span>{reason.label}</span>
                      <strong>{reason.detail}</strong>
                    </div>
                  ))}
                </div>
              </section>

              <section className="order-panel">
                <div className="panel-title">
                  <span>Safe order draft</span>
                  <span>Spot · Limit</span>
                </div>
                <dl className="order-table">
                  <div><dt>Pair</dt><dd>{analysis.symbol}</dd></div>
                  <div><dt>Side</dt><dd className="positive">BUY</dd></div>
                  <div><dt>Notional</dt><dd>{money(analysis.approved, 0)}</dd></div>
                  <div><dt>Est. quantity</dt><dd>{analysis.quantity.toFixed(4)}</dd></div>
                  <div><dt>Reference price</dt><dd>{money(market.lastPrice)}</dd></div>
                </dl>
                <button
                  className="prepare-button"
                  type="button"
                  onClick={prepareOrder}
                  disabled={!analysis.execution.allowedToPrepare || status === "loading"}
                >
                  {status === "prepared" ? (
                    <><Check size={17} /> Order prepared</>
                  ) : analysis.execution.allowedToPrepare ? (
                    <>Prepare {money(analysis.approved, 0)} order <ArrowUpRight size={17} /></>
                  ) : (
                    <><LockKeyhole size={17} /> Order disabled by policy</>
                  )}
                </button>
              </section>
            </div>

            <div className="receipt-strip">
              <div className="receipt-proof">
                <span className="receipt-icon"><FileCheck2 size={17} /></span>
                <span>
                  <strong>Keel Risk Receipt</strong>
                  <small>
                    {receipt
                      ? `${receipt.receiptId} · SHA-256 ${receipt.integrity.digest.slice(0, 12)}…`
                      : status === "loading"
                        ? "Hashing evidence and policy snapshot…"
                        : "Run the check to issue a fresh receipt"}
                  </small>
                </span>
              </div>
              <button
                className="receipt-button"
                type="button"
                onClick={downloadReceipt}
                disabled={!receipt}
              >
                <Download size={15} /> Download JSON
              </button>
            </div>
          </div>

          <footer className="activity-footer">
            <div className="activity-status">
              <span className="pulse-ring" />
              <span>{notice}</span>
            </div>
            <div className="agent-trace" aria-label="Agent execution trace">
              <span><Check size={13} /> Market evidence</span>
              <span><Check size={13} /> Account context</span>
              <span><Check size={13} /> Policy engine</span>
              <span className={status === "prepared" ? "trace-active" : ""}>
                <LockKeyhole size={13} /> Human gate
              </span>
            </div>
            <button className="reset-button" type="button" onClick={reset} aria-label="Reset simulation">
              <RotateCcw size={15} /> Reset
            </button>
          </footer>
        </section>
      </div>
    </main>
  );
}
