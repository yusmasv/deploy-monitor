import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Deploy Monitor",
  description: "Deployment monitor for VPS1/VPS2",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
