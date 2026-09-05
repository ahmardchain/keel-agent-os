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
  ExternalLink,
  FileCheck2,
  Gauge,
  LockKeyhole,
  Radio,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Upload,
} from "lucide-react";
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

import {
  createRiskReceipt,
  DEFAULT_POLICY,
  evaluateRisk,
  extractIntent,
  verifyRiskReceipt,
  type AccountSnapshot,
  type Analysis,
  type Decision,
  type MarketSnapshot,
  type Policy,
  type RiskReceipt,
} from "@/lib/keel";

const AGENT_PROOF_URL = "https://chatgpt.com/s/t_6a9c48c8e5d48191b6fd7148ebf844c0";

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

type EditablePolicyKey =
  | "maxAssetPercent"
  | "maxDailyLossPercent"
  | "lossStreakCooldown"
  | "maxFiveMinuteMovePercent"
  | "maxSpreadBps";

const RULE_FIELDS: Array<{
  key: EditablePolicyKey;
  label: string;
  description: string;
  suffix: string;
  min: number;
  max: number;
  step: number;
}> = [
  {
    key: "maxAssetPercent",
    label: "Maximum per asset",
    description: "Largest share of equity one asset may occupy.",
    suffix: "%",
    min: 1,
    max: 100,
    step: 0.5,
  },
  {
    key: "maxDailyLossPercent",
    label: "Daily loss stop",
    description: "Block new exposure after this daily drawdown.",
    suffix: "%",
    min: 0.1,
    max: 100,
    step: 0.1,
  },
  {
    key: "lossStreakCooldown",
    label: "Loss-streak cooldown",
    description: "Pause after this many consecutive losing trades.",
    suffix: "losses",
    min: 1,
    max: 20,
    step: 1,
  },
  {
    key: "maxFiveMinuteMovePercent",
    label: "Five-minute velocity",
    description: "Pause entries during unusually fast price movement.",
    suffix: "%",
    min: 0.1,
    max: 100,
    step: 0.1,
  },
  {
    key: "maxSpreadBps",
    label: "Maximum clean spread",
    description: "Reduce order size when execution quality is worse.",
    suffix: "bps",
    min: 0.1,
    max: 1000,
    step: 0.1,
  },
];

function money(value: number, digits = 2) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: digits,
  }).format(value);
}

function parsePolicy(value: unknown): Policy | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<Policy>;
  const valid =
    Number.isFinite(Number(candidate.maxAssetPercent)) &&
    Number.isFinite(Number(candidate.maxDailyLossPercent)) &&
    Number.isFinite(Number(candidate.lossStreakCooldown)) &&
    Number.isFinite(Number(candidate.maxFiveMinuteMovePercent)) &&
    Number.isFinite(Number(candidate.maxSpreadBps)) &&
    (candidate.maxAssetPercent ?? 0) >= 1 &&
    (candidate.maxAssetPercent ?? 101) <= 100 &&
    (candidate.maxDailyLossPercent ?? 0) >= 0.1 &&
    (candidate.maxDailyLossPercent ?? 101) <= 100 &&
    (candidate.lossStreakCooldown ?? 0) >= 1 &&
    (candidate.lossStreakCooldown ?? 21) <= 20 &&
    (candidate.maxFiveMinuteMovePercent ?? 0) >= 0.1 &&
    (candidate.maxFiveMinuteMovePercent ?? 101) <= 100 &&
    (candidate.maxSpreadBps ?? 0) >= 0.1 &&
    (candidate.maxSpreadBps ?? 1001) <= 1000;

  if (!valid) return null;
  return {
    ...DEFAULT_POLICY,
    maxAssetPercent: Number(candidate.maxAssetPercent),
    maxDailyLossPercent: Number(candidate.maxDailyLossPercent),
    lossStreakCooldown: Math.round(Number(candidate.lossStreakCooldown)),
    maxFiveMinuteMovePercent: Number(candidate.maxFiveMinuteMovePercent),
    maxSpreadBps: Number(candidate.maxSpreadBps),
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
  const [intent, setIntent] = useState(JUDGE_SCENARIOS[1].prompt);
  const [account, setAccount] = useState<AccountSnapshot>(DEMO_ACCOUNT);
  const [policy, setPolicy] = useState<Policy>({ ...DEFAULT_POLICY });
  const [draftPolicy, setDraftPolicy] = useState<Policy>({ ...DEFAULT_POLICY });
  const [rulebookOpen, setRulebookOpen] = useState(false);
  const [market, setMarket] = useState<MarketSnapshot>(INITIAL_MARKET);
  const [analysis, setAnalysis] = useState<Analysis>(() =>
    evaluateRisk(JUDGE_SCENARIOS[1].prompt, DEMO_ACCOUNT, INITIAL_MARKET),
  );
  const [activeScenarioId, setActiveScenarioId] = useState<JudgeScenario["id"] | null>(null);
  const [receipt, setReceipt] = useState<RiskReceipt | null>(null);
  const [receiptVerification, setReceiptVerification] = useState<"idle" | "valid" | "invalid">("idle");
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "prepared">("idle");
  const [notice, setNotice] = useState("Collecting live Binance market evidence");
  const receiptSequence = useRef(0);
  const receiptInputRef = useRef<HTMLInputElement>(null);

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
    nextPolicy: Policy,
    nextNotice: string,
    sequence: number,
  ) {
    if (sequence !== receiptSequence.current) return;
    const nextAnalysis = evaluateRisk(nextIntent, nextAccount, nextMarket, nextPolicy);

    setAccount(nextAccount);
    setMarket(nextMarket);
    setAnalysis(nextAnalysis);
    setStatus("ready");
    setNotice(nextNotice);
    setReceipt(null);
    setReceiptVerification("idle");

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
    let activePolicy: Policy = { ...DEFAULT_POLICY };
    try {
      const stored = window.localStorage.getItem("keel-policy-v1");
      const parsed = stored ? parsePolicy(JSON.parse(stored)) : null;
      if (parsed) activePolicy = parsed;
    } catch {
      // Invalid device-local preferences fail safely to the documented defaults.
    }
    fetchMarket("SOLUSDT").then(async (snapshot) => {
      if (!active || sequence !== receiptSequence.current) return;
      const nextAnalysis = evaluateRisk(
        JUDGE_SCENARIOS[1].prompt,
        DEMO_ACCOUNT,
        snapshot,
        activePolicy,
      );
      setPolicy(activePolicy);
      setDraftPolicy(activePolicy);
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
    setReceiptVerification("idle");
    setNotice("Agent is collecting market and policy evidence");

    const scenario = JUDGE_SCENARIOS.find((item) => item.id === activeScenarioId);
    if (scenario) {
      await commitCheck(
        intent,
        scenario.account,
        { ...scenario.market, timestamp: new Date().toISOString() },
        DEFAULT_POLICY,
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
      policy,
      "Simulation only · no order has been sent",
      sequence,
    );
  }

  async function selectLiveCheck() {
    const sequence = ++receiptSequence.current;
    setActiveScenarioId(null);
    setStatus("loading");
    setReceipt(null);
    setReceiptVerification("idle");
    setNotice("Refreshing public Binance market evidence");
    const parsed = extractIntent(intent);
    const snapshot = await fetchMarket(parsed.symbol);
    await commitCheck(
      intent,
      DEMO_ACCOUNT,
      snapshot,
      policy,
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
    setReceiptVerification("idle");
    setNotice(`Loading judge case ${scenario.number}`);
    await commitCheck(
      scenario.prompt,
      scenario.account,
      { ...scenario.market, timestamp: new Date().toISOString() },
      DEFAULT_POLICY,
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
    setReceiptVerification("idle");
    setStatus("idle");
    setNotice("Intent changed · run a new live check");
  }

  function reset() {
    receiptSequence.current += 1;
    setIntent(JUDGE_SCENARIOS[1].prompt);
    setActiveScenarioId(null);
    setAccount(DEMO_ACCOUNT);
    setAnalysis(evaluateRisk(JUDGE_SCENARIOS[1].prompt, DEMO_ACCOUNT, market, policy));
    setStatus("ready");
    setReceipt(null);
    setReceiptVerification("idle");
    setNotice("Reset complete · run a new check to issue a receipt");
  }

  function openRulebook() {
    setDraftPolicy({ ...policy });
    setRulebookOpen(true);
  }

  async function applyRulebook(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextPolicy = parsePolicy(draftPolicy);
    if (!nextPolicy) {
      setNotice("Rulebook values are outside the allowed range");
      return;
    }

    const sequence = ++receiptSequence.current;
    setPolicy(nextPolicy);
    setRulebookOpen(false);
    setActiveScenarioId(null);
    setStatus("loading");
    setReceipt(null);
    setReceiptVerification("idle");
    setNotice("Saving your rulebook and re-running the check");
    try {
      window.localStorage.setItem("keel-policy-v1", JSON.stringify(nextPolicy));
    } catch {
      // The active session still uses the policy when device storage is unavailable.
    }

    const parsed = extractIntent(intent);
    const snapshot = await fetchMarket(parsed.symbol);
    await commitCheck(
      intent,
      DEMO_ACCOUNT,
      snapshot,
      nextPolicy,
      "Custom rulebook active · new receipt issued",
      sequence,
    );
  }

  function restoreDefaultRules() {
    setDraftPolicy({ ...DEFAULT_POLICY });
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

  async function verifyReceiptFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      if (file.size > 1_000_000) {
        setReceiptVerification("invalid");
        setNotice("Receipt verification failed · JSON file exceeds the 1 MB safety limit");
        return;
      }
      const candidate = JSON.parse(await file.text()) as unknown;
      const valid = await verifyRiskReceipt(candidate);
      setReceiptVerification(valid ? "valid" : "invalid");
      setNotice(
        valid
          ? "Receipt verified · evidence, policy, and decision match the SHA-256 fingerprint"
          : "Receipt verification failed · the payload or fingerprint has been altered",
      );
    } catch {
      setReceiptVerification("invalid");
      setNotice("Receipt verification failed · this is not valid Keel receipt JSON");
    } finally {
      event.target.value = "";
    }
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
  const activePolicy = analysis.policySnapshot;
  const lossUsed = Math.max(0, -account.dayPnl);
  const dailyLossBuffer = Math.max(
    0,
    Math.round(((activePolicy.maxDailyLossPercent - lossUsed) / activePolicy.maxDailyLossPercent) * 100),
  );
  const sourceLabel =
    market.source === "live" ? "Live" : market.source === "judge" ? "Judge fixture" : "Fallback fixture";
  const activeScenario = JUDGE_SCENARIOS.find((scenario) => scenario.id === activeScenarioId);

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Keel home">
          <span className="brand-mark" aria-hidden="true">K</span>
          <span className="brand-copy">
            <strong>Keel</strong>
            <small>Trade permission</small>
          </span>
        </a>
        <div className="topbar-meta">
          <span className="session-label">
            {activeScenario ? `CASE ${activeScenario.number}` : "LIVE / DEMO"}
          </span>
          <a
            className="network-badge network-proof"
            href={AGENT_PROOF_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="Open the live Binance Agent OS conversation proof"
          >
            <span className="status-dot" /> Binance Agent OS <ExternalLink size={12} />
          </a>
        </div>
      </header>

      <div className="workspace" id="top">
        <aside className="risk-rail">
          <div className="rail-masthead">
            <span>Control panel</span>
            <strong>SPOT / 01</strong>
          </div>
          <section className="account-block">
            <div className="rail-section-label"><span>01</span> Capital</div>
            <div className="eyebrow">Protected equity</div>
            <div className="equity-value">{money(account.equity)}</div>
            <div className="account-line">
              <span>Available</span>
              <strong>{money(account.available)}</strong>
            </div>
          </section>

          <section className="risk-meter" aria-label="Daily loss buffer">
            <div className="section-heading">
              <span><em>02</em> Daily loss buffer</span>
              <strong>{dailyLossBuffer}%</strong>
            </div>
            <div className="meter-track">
              <span style={{ width: `${dailyLossBuffer}%` }} />
            </div>
            <p>
              {account.dayPnl <= -activePolicy.maxDailyLossPercent
                ? "Daily stop reached. New exposure is blocked."
                : `${Math.max(0, activePolicy.maxDailyLossPercent - lossUsed).toFixed(1)}% remains before the hard stop.`}
            </p>
          </section>

          <section className="rules-block">
            <div className="section-heading">
              <span><em>03</em> Active rulebook</span>
              <button className="rule-edit-button" type="button" onClick={openRulebook}>
                <SlidersHorizontal size={13} /> Edit
              </button>
            </div>
            <ul className="rule-list">
              <li>
                <ShieldCheck size={16} />
                <span><strong>{activePolicy.maxAssetPercent}%</strong> max per asset</span>
              </li>
              <li>
                <CircleDollarSign size={16} />
                <span><strong>{activePolicy.maxDailyLossPercent}%</strong> daily loss cap</span>
              </li>
              <li>
                <Clock3 size={16} />
                <span>Pause after <strong>{activePolicy.lossStreakCooldown} losses</strong></span>
              </li>
              <li>
                <Activity size={16} />
                <span>Reject above <strong>{activePolicy.maxFiveMinuteMovePercent}% / 5m</strong></span>
              </li>
              <li>
                <Gauge size={16} />
                <span>Haircut above <strong>{activePolicy.maxSpreadBps} bps</strong></span>
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
            <div className="command-heading">
              <div>
                <div className="section-kicker">Decision workspace</div>
                <h2>Check the trade before it moves.</h2>
              </div>
              <p>Describe one Spot buy. Your rulebook controls the size.</p>
            </div>
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

          <div className="market-strip" aria-label="Current market evidence">
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

          <div
            className={`decision-card decision-${analysis.decision.toLowerCase()}`}
            data-decision={analysis.decision}
          >
            <div className="decision-header">
              <div>
                <div className="decision-label">
                  <span>{analysis.decision}</span> Policy result / {analysis.primaryCode.replaceAll("_", " ")}
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
                  <span>04 / Evidence ledger</span>
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
                  <span>05 / Safe order draft</span>
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

            <div className={`receipt-strip receipt-${receiptVerification}`}>
              <div className="receipt-proof">
                <span className="receipt-icon"><FileCheck2 size={17} /></span>
                <span>
                  <strong>Keel Risk Receipt</strong>
                  <small>
                    {receiptVerification === "valid"
                      ? "Integrity verified · protected payload matches its fingerprint"
                      : receiptVerification === "invalid"
                        ? "Verification failed · receipt content or fingerprint changed"
                        : receipt
                      ? `${receipt.receiptId} · SHA-256 ${receipt.integrity.digest.slice(0, 12)}…`
                      : status === "loading"
                        ? "Hashing evidence and policy snapshot…"
                        : "Run the check to issue a fresh receipt"}
                  </small>
                </span>
              </div>
              <div className="receipt-actions">
                <input
                  ref={receiptInputRef}
                  className="sr-only"
                  type="file"
                  accept="application/json,.json"
                  onChange={verifyReceiptFile}
                  aria-label="Choose a Keel receipt to verify"
                />
                <button
                  className="receipt-button verify-button"
                  type="button"
                  onClick={() => receiptInputRef.current?.click()}
                >
                  <Upload size={15} /> Verify JSON
                </button>
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

      <Dialog
        open={rulebookOpen}
        onOpenChange={(open) => {
          setRulebookOpen(open);
          if (open) setDraftPolicy({ ...policy });
        }}
      >
        <DialogContent className="rulebook-dialog">
          <DialogHeader>
            <div className="dialog-kicker">Personal policy</div>
            <DialogTitle>Your rulebook</DialogTitle>
            <DialogDescription>
              These limits control live checks and are stored only on this device. Judge cases stay locked to the documented defaults.
            </DialogDescription>
          </DialogHeader>
          <form className="rulebook-form" onSubmit={applyRulebook}>
            <div className="rulebook-fields">
              {RULE_FIELDS.map((field) => (
                <label className="rulebook-field" key={field.key}>
                  <span>
                    <strong>{field.label}</strong>
                    <small>{field.description}</small>
                  </span>
                  <span className="rule-value-control">
                    <Input
                      type="number"
                      min={field.min}
                      max={field.max}
                      step={field.step}
                      value={draftPolicy[field.key]}
                      onChange={(event) =>
                        setDraftPolicy((current) => ({
                          ...current,
                          [field.key]: Number(event.target.value),
                        }))
                      }
                      required
                      aria-label={field.label}
                    />
                    <em>{field.suffix}</em>
                  </span>
                </label>
              ))}
            </div>
            <div className="rulebook-actions">
              <button className="rulebook-reset" type="button" onClick={restoreDefaultRules}>
                Restore defaults
              </button>
              <button className="rulebook-save" type="submit">
                Save and re-check <ChevronRight size={16} />
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </main>
  );
}
