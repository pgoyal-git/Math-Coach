import type { Metadata } from "next";
import Script from "next/script";
import "katex/dist/katex.min.css";
import "mathlive/static.css";
import "./globals.css";

const GOOGLE_ANALYTICS_ID = "G-PG1NQWP058";

export const metadata: Metadata = {
  title: "Math Coach",
  description: "An adaptive Socratic coach for AMC and AIME problem solving.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${GOOGLE_ANALYTICS_ID}`}
        strategy="afterInteractive"
      />
      <Script id="google-analytics" strategy="afterInteractive">
        {`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('config', '${GOOGLE_ANALYTICS_ID}', {
            allow_google_signals: false,
            allow_ad_personalization_signals: false
          });
        `}
      </Script>
    </html>
  );
}
