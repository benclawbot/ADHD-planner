import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tempo Planner",
  description: "Plan your day, week, focus time, and captured thoughts.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
