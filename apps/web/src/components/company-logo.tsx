"use client";

import { useState } from "react";

import { jobLogoUrl, jobMonogram } from "@/lib/job-display";
import type { PublicJob } from "@/lib/api";

/**
 * The logo square every job card already had — now with the company's actual
 * logo in it when one is known.
 *
 * Same element, same size, same tinted background: the monogram is still what
 * renders for a job with no logo, and the layout does not move between the two
 * cases. This is deliberately not a redesign, only a picture inside the box that
 * was already there.
 *
 * Three things keep a logo from ever being worse than the monogram:
 *
 *  - No URL, or a non-https one, and the monogram renders with no image request
 *    at all (see `jobLogoUrl`).
 *  - A URL that fails to load falls back to the monogram, so a provider outage
 *    or a withdrawn icon shows the same square as before rather than a broken
 *    image. That is what `failed` is for.
 *  - The image is decorative — the company name is already text next to it — so
 *    the whole square stays `aria-hidden`, exactly as it was.
 *
 * A plain `img` rather than `next/image`: the host comes from a provider chosen
 * by an API-side environment variable, so it cannot be enumerated in
 * `next.config.ts` at build time. These are ~1 KB icons, loaded lazily.
 */
export function CompanyLogo({ job, className }: { job: PublicJob; className: string }) {
  const url = jobLogoUrl(job);
  const [failed, setFailed] = useState(false);

  const monogram = jobMonogram(job);
  const showLogo = url !== null && !failed;

  return (
    <span aria-hidden="true" className={className}>
      {showLogo ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          /* Contained rather than cropped: a wordmark and a square glyph both
             have to fit the same box without being cut off. */
          className="size-full rounded-[inherit] object-contain p-1"
          onError={() => setFailed(true)}
        />
      ) : (
        monogram
      )}
    </span>
  );
}
