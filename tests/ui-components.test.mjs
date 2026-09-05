import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  resolve: { alias: { "@": root } },
  server: { middlewareMode: true },
});

after(async () => {
  await vite.close();
});

async function readCssTree(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const contents = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return readCssTree(entryPath);
      }
      return entry.name.endsWith(".css") ? readFile(entryPath, "utf8") : "";
    }),
  );
  return contents.join("\n");
}

test("emits the catalog's animation and scrolling utilities", async () => {
  const css = await readCssTree(path.join(root, "dist"));

  assert.match(css, /--tw-enter-opacity/);
  assert.match(css, /scrollbar-width:\s*thin/);
  assert.match(css, /scrollbar-width:\s*none/);
  assert.match(css, /scrollbar-gutter:\s*stable/);
  assert.match(css, /scroll-fade-reveal-b/);
  assert.match(css, /mask-image:/);
  assert.match(css, /tw-shimmer/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

test("forwards progress semantics to the primitive", async () => {
  const { Progress } = await vite.ssrLoadModule("/components/ui/progress.tsx");
  const html = renderToStaticMarkup(React.createElement(Progress, { value: 37 }));

  assert.match(html, /aria-valuenow="37"/);
  assert.match(html, /aria-valuetext="37%"/);
  assert.match(html, /data-state="loading"/);
});

test("emits chart themes for the starter's media dark mode", async () => {
  const { ChartStyle } = await vite.ssrLoadModule("/components/ui/chart.tsx");
  const html = renderToStaticMarkup(
    React.createElement(ChartStyle, {
      id: "contract",
      config: {
        latency: { theme: { light: "#ffffff", dark: "#000000" } },
      },
    }),
  );

  assert.match(html, /\[data-chart=contract\]/);
  assert.match(html, /@media \(prefers-color-scheme: dark\)/);
  assert.doesNotMatch(html, /\.dark/);
});

test("renders sidebar skeletons deterministically", async () => {
  const { SidebarMenuSkeleton } = await vite.ssrLoadModule(
    "/components/ui/sidebar.tsx",
  );
  const first = renderToStaticMarkup(React.createElement(SidebarMenuSkeleton));
  const second = renderToStaticMarkup(React.createElement(SidebarMenuSkeleton));

  assert.equal(first, second);
  assert.match(first, /--skeleton-width:70%/);
});

test("verifies browser risk receipts and rejects edited payloads", async () => {
  const { createRiskReceipt, evaluateRisk, verifyRiskReceipt } = await vite.ssrLoadModule(
    "/lib/keel.ts",
  );
  const account = {
    equity: 4860.2,
    available: 1610.42,
    dayPnl: -2.1,
    lossStreak: 2,
    existingExposure: { SOLUSDT: 389 },
  };
  const market = {
    symbol: "SOLUSDT",
    lastPrice: 143.18,
    priceChangePercent: 2.84,
    fiveMinuteMove: 0.62,
    spreadBps: 1.7,
    bidDepthOnePercent: 2840000,
    askDepthOnePercent: 2510000,
    highPrice: 146.92,
    lowPrice: 137.61,
    closes: [139.2, 140.1, 141.2, 143.18],
    source: "judge",
    timestamp: "2026-09-05T15:30:00.000Z",
  };
  const analysis = evaluateRisk("Buy $1,200 of SOL because it is pumping", account, market);
  analysis.evaluatedAt = "2026-09-05T15:30:01.000Z";
  const receipt = await createRiskReceipt({
    rawIntent: "Buy $1,200 of SOL because it is pumping",
    account,
    market,
    analysis,
  });

  assert.equal(await verifyRiskReceipt(receipt), true);
  const tampered = structuredClone(receipt);
  tampered.payload.policy.maxAssetPercent = 100;
  assert.equal(await verifyRiskReceipt(tampered), false);
});
