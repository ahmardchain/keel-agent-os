"use client";

import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  LockKeyhole,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

type MarketSnapshot = {
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
  source: "live" | "fallback";
  timestamp: string;
};

type Decision = "APPROVE" | "RESIZE" | "PAUSE" | "BLOCK";

type Analysis = {
  decision: Decision;
  requested: number;
  approved: number;
  symbol: string;
  quantity: number;
  reasons: Array<{
    label: string;
    detail: string;
    tone: "pass" | "warn" | "stop";
  }>;
};

const DEMO_ACCOUNT = {
  equity: 4860.2,
  available: 1610.42,
  dayPnl: -2.1,
  lossStreak: 2,
  existingExposure: {
    SOLUSDT: 389,
    BTCUSDT: 580,
    ETHUSDT: 250,
    BNBUSDT: 120,
  } as Record<string, number>,
};

const FALLBACK_MARKET: MarketSnapshot = {
  symbol: "SOLUSDT",
  lastPrice: 143.18,
  priceChangePercent: 2.84,
  fiveMinuteMove: 0.62,
  spreadBps: 1.7,
  bidDepthOnePercent: 2840000,
  askDepthOnePercent: 2510000,
  highPrice: 146.92,
  lowPrice: 137.61,
  closes: [139.2, 139.8, 139.4, 140.6, 140.1, 141.5, 141.2, 142.4, 141.9, 143.18],
  source: "fallback",
  timestamp: new Date().toISOString(),
};

const SAMPLE_PROMPTS = [
  "Buy $1,200 of SOL because it is pumping",
  "Put 250 USDT into BTC",
  "Can I add $600 of ETH?",
];

function money(value: number, digits = 2) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: digits,
  }).format(value);
}

function compactMoney(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function extractIntent(input: string) {
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

function createAnalysis(input: string, market: MarketSnapshot): Analysis {
  const { symbol, amount } = extractIntent(input);
  const positionLimit = DEMO_ACCOUNT.equity * 0.15;
  const currentExposure = DEMO_ACCOUNT.existingExposure[symbol] ?? 0;
  const remainingCapacity = Math.max(0, positionLimit - currentExposure);
  const sizeAfterLiquidity = market.spreadBps > 12 ? remainingCapacity * 0.5 : remainingCapacity;
  const approved = Math.max(0, Math.floor(Math.min(amount, sizeAfterLiquidity) / 10) * 10);

  let decision: Decision = "APPROVE";
  if (DEMO_ACCOUNT.dayPnl <= -3 || approved < 10) decision = "BLOCK";
  else if (Math.abs(market.fiveMinuteMove) >= 4) decision = "PAUSE";
  else if (approved < amount) decision = "RESIZE";

  const reasons: Analysis["reasons"] = [
    {
      label: "Daily loss",
      detail: `${DEMO_ACCOUNT.dayPnl.toFixed(1)}% of −3.0% limit`,
      tone: DEMO_ACCOUNT.dayPnl <= -3 ? "stop" : "pass",
    },
    {
      label: "Position concentration",
      detail: `${money(currentExposure, 0)} already in ${symbol.replace("USDT", "")} · 15% cap`,
      tone: approved < amount ? "warn" : "pass",
    },
    {
      label: "Market velocity",
      detail: `${market.fiveMinuteMove >= 0 ? "+" : ""}${market.fiveMinuteMove.toFixed(2)}% over 5m`,
      tone: Math.abs(market.fiveMinuteMove) >= 4 ? "stop" : "pass",
    },
    {
      label: "Execution quality",
      detail: `${market.spreadBps.toFixed(1)} bps spread · ${compactMoney(market.bidDepthOnePercent)} bid depth`,
      tone: market.spreadBps > 12 ? "warn" : "pass",
    },
  ];

  return {
    decision,
    requested: amount,
    approved,
    symbol,
    quantity: market.lastPrice > 0 ? approved / market.lastPrice : 0,
    reasons,
  };
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
  const [intent, setIntent] = useState(SAMPLE_PROMPTS[0]);
  const [market, setMarket] = useState<MarketSnapshot>(FALLBACK_MARKET);
  const [analysis, setAnalysis] = useState<Analysis>(() =>
    createAnalysis(SAMPLE_PROMPTS[0], FALLBACK_MARKET),
  );
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "prepared">("idle");
  const [notice, setNotice] = useState("Simulation only · no order has been sent");

  const fetchMarket = useCallback(async (symbol: string) => {
    try {
      const response = await fetch(`/api/market?symbol=${encodeURIComponent(symbol)}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Market request failed");
      return (await response.json()) as MarketSnapshot;
    } catch {
      return { ...FALLBACK_MARKET, symbol, timestamp: new Date().toISOString() };
    }
  }, []);

  useEffect(() => {
    let active = true;
    fetchMarket("SOLUSDT").then((snapshot) => {
      if (!active) return;
      setMarket(snapshot);
      setAnalysis(createAnalysis(SAMPLE_PROMPTS[0], snapshot));
      setStatus("ready");
    });
    return () => {
      active = false;
    };
  }, [fetchMarket]);

  async function runCheck() {
    const parsed = extractIntent(intent);
    setStatus("loading");
    setNotice("Agent is collecting market and policy evidence");
    const snapshot = await fetchMarket(parsed.symbol);
    setMarket(snapshot);
    setAnalysis(createAnalysis(intent, snapshot));
    setStatus("ready");
    setNotice("Simulation only · no order has been sent");
  }

  function prepareOrder() {
    setStatus("prepared");
    setNotice("Order prepared. Binance confirmation would be required before execution.");
  }

  function reset() {
    setIntent(SAMPLE_PROMPTS[0]);
    setAnalysis(createAnalysis(SAMPLE_PROMPTS[0], market));
    setStatus("ready");
    setNotice("Simulation only · no order has been sent");
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
      text: "Short-term velocity is outside the range you allow.",
    },
    BLOCK: {
      title: "Trading paused",
      text: "Your daily protection rule has stopped new exposure.",
    },
  };

  const display = decisionCopy[analysis.decision];
  const timestamp = new Date(market.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

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
          <span className="session-label">Agentic account · Demo</span>
        </div>
      </header>

      <div className="workspace" id="top">
        <aside className="risk-rail">
          <section className="account-block">
            <div className="eyebrow">Protected equity</div>
            <div className="equity-value">{money(DEMO_ACCOUNT.equity)}</div>
            <div className="account-line">
              <span>Available</span>
              <strong>{money(DEMO_ACCOUNT.available)}</strong>
            </div>
          </section>

          <section className="risk-meter" aria-label="Risk capacity">
            <div className="section-heading">
              <span>Risk capacity</span>
              <strong>68%</strong>
            </div>
            <div className="meter-track">
              <span style={{ width: "68%" }} />
            </div>
            <p>One more loss triggers your cooldown.</p>
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
            <span>Keel can prepare an order. Only you can approve execution.</span>
          </div>
        </aside>

        <section className="main-panel">
          <div className="command-section">
            <div className="section-kicker">Pre-trade check</div>
            <div className="command-box">
              <textarea
                value={intent}
                onChange={(event) => setIntent(event.target.value)}
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
            <div className="prompt-row" aria-label="Example trade prompts">
              {SAMPLE_PROMPTS.map((prompt, index) => (
                <button key={prompt} type="button" onClick={() => setIntent(prompt)}>
                  0{index + 1} <span>{prompt}</span>
                </button>
              ))}
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
              {market.source === "live" ? "Live" : "Fallback"} · {timestamp}
            </div>
          </div>

          <div className={`decision-card decision-${analysis.decision.toLowerCase()}`}>
            <div className="decision-header">
              <div>
                <div className="decision-label">
                  <span>{analysis.decision}</span> Risk decision
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
                  <span>04 checks</span>
                </div>
                <div className="evidence-list">
                  {analysis.reasons.map((reason) => (
                    <div className="evidence-row" key={reason.label}>
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
                  disabled={
                    analysis.decision === "BLOCK" ||
                    analysis.decision === "PAUSE" ||
                    status === "loading"
                  }
                >
                  {status === "prepared" ? (
                    <><Check size={17} /> Order prepared</>
                  ) : (
                    <>Prepare {money(analysis.approved, 0)} order <ArrowUpRight size={17} /></>
                  )}
                </button>
              </section>
            </div>
          </div>

          <footer className="activity-footer">
            <div className="activity-status">
              <span className="pulse-ring" />
              <span>{notice}</span>
            </div>
            <div className="agent-trace" aria-label="Agent execution trace">
              <span><Check size={13} /> Market data</span>
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
