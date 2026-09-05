const SUPPORTED_SYMBOLS = new Set([
  "BTCUSDT",
  "ETHUSDT",
  "BNBUSDT",
  "SOLUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "ADAUSDT",
]);

const BINANCE_ENDPOINTS = ["https://api.binance.com", "https://data-api.binance.vision"];

type Ticker = {
  lastPrice: string;
  priceChangePercent: string;
  highPrice: string;
  lowPrice: string;
};

type OrderBook = {
  bids: [string, string][];
  asks: [string, string][];
};

type Kline = [number, string, string, string, string, string, ...unknown[]];

async function readBinance<T>(baseUrl: string, path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Binance responded with ${response.status}`);
  }

  return (await response.json()) as T;
}

async function collectSnapshot(baseUrl: string, symbol: string) {
  const encodedSymbol = encodeURIComponent(symbol);
  const [ticker, depth, klines] = await Promise.all([
    readBinance<Ticker>(baseUrl, `/api/v3/ticker/24hr?symbol=${encodedSymbol}`),
    readBinance<OrderBook>(baseUrl, `/api/v3/depth?symbol=${encodedSymbol}&limit=100`),
    readBinance<Kline[]>(baseUrl, `/api/v3/klines?symbol=${encodedSymbol}&interval=5m&limit=24`),
  ]);

  const lastPrice = Number(ticker.lastPrice);
  const bestBid = Number(depth.bids[0]?.[0] ?? lastPrice);
  const bestAsk = Number(depth.asks[0]?.[0] ?? lastPrice);
  const midpoint = (bestBid + bestAsk) / 2 || lastPrice;
  const spreadBps = midpoint > 0 ? ((bestAsk - bestBid) / midpoint) * 10_000 : 0;
  const lowerBound = lastPrice * 0.99;
  const upperBound = lastPrice * 1.01;

  const bidDepthOnePercent = depth.bids.reduce((total, [priceText, quantityText]) => {
    const price = Number(priceText);
    const quantity = Number(quantityText);
    return price >= lowerBound ? total + price * quantity : total;
  }, 0);

  const askDepthOnePercent = depth.asks.reduce((total, [priceText, quantityText]) => {
    const price = Number(priceText);
    const quantity = Number(quantityText);
    return price <= upperBound ? total + price * quantity : total;
  }, 0);

  const closes = klines.map((kline) => Number(kline[4])).filter(Number.isFinite);
  const priorClose = closes.at(-2) ?? closes.at(-1) ?? lastPrice;
  const fiveMinuteMove = priorClose > 0 ? ((lastPrice - priorClose) / priorClose) * 100 : 0;

  if (![lastPrice, spreadBps, bidDepthOnePercent, askDepthOnePercent].every(Number.isFinite)) {
    throw new Error("Binance returned an invalid market snapshot");
  }

  return {
    symbol,
    lastPrice,
    priceChangePercent: Number(ticker.priceChangePercent),
    fiveMinuteMove,
    spreadBps,
    bidDepthOnePercent,
    askDepthOnePercent,
    highPrice: Number(ticker.highPrice),
    lowPrice: Number(ticker.lowPrice),
    closes,
    source: "live" as const,
    timestamp: new Date().toISOString(),
  };
}

export async function GET(request: Request) {
  const symbol = new URL(request.url).searchParams.get("symbol")?.toUpperCase() ?? "SOLUSDT";

  if (!SUPPORTED_SYMBOLS.has(symbol)) {
    return Response.json(
      { error: "Unsupported symbol", supported: [...SUPPORTED_SYMBOLS] },
      { status: 400 },
    );
  }

  for (const baseUrl of BINANCE_ENDPOINTS) {
    try {
      const snapshot = await collectSnapshot(baseUrl, symbol);
      return Response.json(snapshot, {
        headers: { "Cache-Control": "public, max-age=5, stale-while-revalidate=15" },
      });
    } catch {
      // Try Binance's public market-data mirror before returning a safe failure.
    }
  }

  return Response.json(
    { error: "Live Binance market data is temporarily unavailable" },
    { status: 503 },
  );
}
