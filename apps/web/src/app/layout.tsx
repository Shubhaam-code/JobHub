import type { Metadata, Viewport } from "next";
import { Lexend, Source_Sans_3 } from "next/font/google";
import "./globals.css";

import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

/* "Corporate Trust" pairing from ui-ux-pro-max. Lexend is designed for reading
   proficiency, which suits a page whose job is scanning listings quickly. */
const lexend = Lexend({
  variable: "--font-lexend",
  subsets: ["latin"],
  display: "swap",
});

const sourceSans = Source_Sans_3({
  variable: "--font-source-sans",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "JobFeed — jobs and internships for your batch",
  description:
    "JobFeed gathers jobs and internships from public channels and lists them by role, batch and location, so you can see what is actually open to you in one place.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${lexend.variable} ${sourceSans.variable} h-full antialiased`}>
      {/* Chrome lives here rather than in each page. It was previously assembled
          inside the homepage, which left /jobs/[id] with no header, no nav and no
          footer — the detail view lost the product entirely. One shell means both
          routes get the same brand, the same skip link and the same footer. */}
      <body className="flex min-h-full flex-col">
        <SiteHeader />
        <main id="main" className="flex-1">
          {children}
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}
