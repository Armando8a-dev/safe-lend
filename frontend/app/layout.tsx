import type { Metadata } from "next";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "SafeLend — Over-collateralized Lending",
  description: "Deposit collateral, borrow against it, and watch your health factor. Price-driven liquidations, on Sepolia.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
