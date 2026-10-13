import type { Metadata } from "next";
import "katex/dist/katex.min.css";
import "mathlive/static.css";
import "./globals.css";

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
    </html>
  );
}
