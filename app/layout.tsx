import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Keel — Pre-trade clearance",
  description:
    "A personal risk governor for Binance Agent OS that checks every trade before execution.",
  other: {
    "codex-preview": "development",
  },
  icons: [{ rel: "icon", url: "/favicon.svg", type: "image/svg+xml" }],
};

export const viewport: Viewport = {
  colorScheme: "light",
  themeColor: "#e7e4dc",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
