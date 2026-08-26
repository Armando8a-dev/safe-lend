import type { Metadata } from "next";
import { Chivo, Roboto_Mono } from "next/font/google";
import { Providers } from "./providers";
import "./globals.css";

const chivo = Chivo({
  subsets: ["latin"],
  weight: ["400", "600", "700", "900"],
  variable: "--font-display",
});
const robotoMono = Roboto_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-num",
});

export const metadata: Metadata = {
  title: "SafeLend — Risk Desk",
  description: "Deposit collateral, borrow against it, and watch the health factor. Below 1.00 the position is liquidatable at a 5% discount.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${chivo.variable} ${robotoMono.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
