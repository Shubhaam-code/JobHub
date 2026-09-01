import Image from "next/image";
import Link from "next/link";
import { ArrowRight, BellRing, Briefcase, MapPin, Wallet } from "lucide-react";

import { JobSearchForm } from "@/components/job-search-form";
import { SIGN_UP_PATH } from "@/lib/clerk";

/**
 * The landing hero, following the reference design's composition: the headline and
 * search card in a narrow left column, an illustrative right column carrying two
 * photographic cutouts with cards floating around them, a stats row along the
 * bottom of the left column and a notify band under the right one.
 *
 * The two cutouts are `hero-girl.png` and `hero-boy.png`, built from the supplied
 * `girl.png` / `boy.png` by `scripts/hero-assets.mjs` — the sources are flattened
 * onto an opaque black matte and would render as black rectangles here. Each file
 * is trimmed to its blob, so its aspect ratio *is* the blob's: giving a wrapper a
 * width is enough to place it, and nothing is cropped or stretched.
 *
 * Card contents split two ways. The example listing is openly a sample — the
 * reference fills that slot with a Google job, and this project has no company
 * logos and no way to verify a posting it did not ingest, so the card carries the
 * reference's placeholder text under a "Sample listing" label rather than passing
 * invented data off as the feed. The ring and the dark pill are the opposite: the
 * feed genuinely reports both figures, so they show the real ones.
 *
 * Both real values are optional. The API can be down or the feed empty, and a
 * landing page must still render, so each of those two cards is dropped rather than
 * shown holding a zero.
 */
export function WelcomeHero({
  totalJobs,
  weekJobs,
}: {
  totalJobs: number | null;
  weekJobs: number | null;
}) {
  /* Only meaningful with a non-empty feed: a share of nothing is not 0%, it is
     undefined, and the ring is dropped instead of drawn empty. */
  const weekShare =
    totalJobs !== null && totalJobs > 0 && weekJobs !== null
      ? Math.round((weekJobs / totalJobs) * 100)
      : null;

  return (
    <section className="mx-auto w-full max-w-[88rem] px-4 pt-6 pb-8 sm:px-6 lg:px-8 lg:pt-6 lg:pb-8">
      {/* Column split and gap come from the reference, which is a 1536-wide
          design: the search column is about half the width of the illustrative
          one, with a wide channel between them. Both are eased back at narrower
          desktops — at 1024 that ratio leaves the search card too thin to hold its
          own copy — and reach the reference's proportions at 2xl. */}
      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,0.75fr)_minmax(0,1fr)] lg:gap-x-20 xl:grid-cols-[minmax(0,0.6fr)_minmax(0,1fr)] xl:gap-x-28 2xl:grid-cols-[minmax(0,0.5fr)_minmax(0,1fr)] 2xl:gap-x-36">
        {/* --- Left column: headline, search card, stats ---------------------- */}
        <div>
          {/* Two lines, as in the reference — where "dream job." is a shade wider
              than the search card under it. `whitespace-nowrap` keeps the break
              between the two written lines instead of letting the column's width
              choose a third; the overhang lands in the channel between columns,
              which is why that channel is sized above rather than left to
              `gap-12`. Sized to keep the whole hero — stats and notify band
              included — inside one desktop viewport. */}
          <h1 className="font-heading text-[2.75rem] leading-[1.03] font-bold tracking-display text-foreground sm:text-6xl lg:text-[3.25rem] lg:leading-[1.06] lg:whitespace-nowrap xl:text-[3.5rem] 2xl:text-[3.75rem]">
            <span className="block">Get your</span>
            <span className="relative inline-block">
              dream job.
              {/* The reference underlines the second line with a hand-drawn
                  stroke. An SVG curve rather than a straight border, so it keeps
                  that drawn quality, and aria-hidden because it says nothing the
                  heading does not. */}
              <svg
                aria-hidden="true"
                viewBox="0 0 300 14"
                preserveAspectRatio="none"
                className="absolute -bottom-1 left-0 h-2.5 w-full text-primary sm:-bottom-2 sm:h-3"
              >
                <path
                  d="M3 10.5C52 4.2 158 2.5 297 6.8"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="5"
                  strokeLinecap="round"
                />
              </svg>
            </span>
          </h1>

          <div className="mt-5 w-full rounded-xl border border-border bg-surface p-4 shadow-e2 sm:p-5 lg:mt-5 lg:w-[360px] lg:p-4">
            <h2 className="font-heading text-xl leading-tight font-semibold tracking-snug text-foreground sm:text-2xl lg:text-xl">
              Search for a job
            </h2>
            <p className="mt-1.5 text-[15px] leading-relaxed text-muted-foreground lg:text-[14px]">
              Every opening collected in one feed. Search by role, company or location and apply
              straight at the source.
            </p>

            <div className="mt-4">
              {/* The real search. Submitting navigates to /jobs with the words in
                  the URL, where the date and job-type filters live. */}
              <JobSearchForm variant="stacked" />
            </div>
          </div>

          {(totalJobs !== null || weekJobs !== null) && (
            <dl className="mt-6 flex flex-wrap gap-10 sm:gap-14 lg:gap-16">
              {totalJobs !== null && (
                <Stat value={totalJobs} label={totalJobs === 1 ? "Job posted" : "Jobs posted"} />
              )}
              {weekJobs !== null && <Stat value={weekJobs} label="Posted this week" />}
            </dl>
          )}
        </div>

        {/* --- Right column: illustrative area, then the notify band ----------
            The reference starts this column a little higher than the headline —
            the sample card sits just under the nav bar — hence the negative top
            margin at desktop. */}
        <div className="lg:-mt-4">
          {/* One markup, two layouts. Below lg the two cutouts sit side by side and
              the cards fall into a grid beneath them, which is the only thing that
              fits a phone; from lg everything is placed over the shared canvas the
              way the reference arranges it.

              The canvas takes an aspect ratio rather than a fixed height, so every
              percentage placed on it holds at any desktop width. It flattens as the
              column widens — the cutouts and the floating cards need a certain
              number of pixels of headroom, and only a wide column can give them
              that while staying as shallow as the reference. */}
          <div className="relative lg:aspect-square xl:aspect-[6/5] 2xl:aspect-[133/100]">
            <Cutouts />

            <div className="mt-6 grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start lg:mt-0 lg:block">
              <SampleJobCard />
              {weekShare !== null && <FreshRing share={weekShare} />}
              {totalJobs !== null && <LiveCountPill total={totalJobs} />}
            </div>

            <ApplyPill />
          </div>

          <NotifyBand />
        </div>
      </div>
    </section>
  );
}

/** One of the two figures under the search card. */
function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div>
      {/* dt after dd in the markup would be invalid, so the pair is ordered
          normally and the visual order comes from the wrapper. */}
      <dd className="font-heading text-4xl leading-none font-bold tracking-display text-foreground tabular-nums sm:text-[2.5rem]">
        {value.toLocaleString("en-US")}
      </dd>
      <dt className="mt-1.5 text-[15px] text-muted-foreground">{label}</dt>
    </div>
  );
}

/**
 * The two photographic cutouts: the girl on the left, taller and sitting on the
 * canvas floor, the boy on the right and lifted off it, which is the offset the
 * reference uses to keep the pair from reading as a matched set.
 *
 * Widths are percentages of the column and heights come from each file's own
 * aspect ratio, so neither is cropped or distorted at any breakpoint. Both are
 * anchored to the *bottom* of the canvas rather than the top: that is what keeps
 * the ring card at the girl's hem and the dark pill across the boy's, whatever
 * height the canvas resolves to at a given width.
 *
 * Below lg they are a bottom-aligned row — the boy's shorter frame lines up with
 * the girl's hem instead of floating — and from lg they are absolutely placed on
 * the canvas.
 *
 * `alt=""`: both are decoration. Nothing here is information the headline, the
 * search card and the floating cards do not already carry in text.
 */
function Cutouts() {
  return (
    <div className="flex items-end justify-center gap-8 sm:gap-4 lg:block">
      <div className="w-[46%] max-w-[15rem] lg:absolute lg:bottom-0 lg:left-0 lg:w-[41.5%] lg:max-w-none">
        <Image
          src="/hero-girl.png"
          alt=""
          width={740}
          height={1122}
          sizes="(min-width: 1024px) 22vw, 44vw"
          priority
          className="h-auto w-full -translate-y-24 relative left-10 scale-90"
        />
      </div>

      <div className="w-[44%] max-w-[14rem] lg:absolute lg:bottom-[8%] lg:-right-[1%] lg:w-[35%] lg:max-w-none">
        <Image
          src="/hero-boy.png"
          alt=""
          width={866}
          height={1172}
          sizes="(min-width: 1024px) 22vw, 42vw"
          priority
          className="h-auto w-full -translate-y-20 relative left-0 scale-90"
        />
      </div>
    </div>
  );
}

/**
 * The example listing, in the slot the reference gives its Google job card.
 *
 * Openly a sample: the label says so, and it is the only card here whose content is
 * not read from the feed. It exists because the slot is load-bearing in the
 * composition — it is what tells a first-time visitor what a posting in this
 * product looks like — and the alternative was either an empty corner or a made-up
 * posting presented as real.
 *
 * The mark is a stylised four-colour ring, not any company's logo file: the point
 * is the reference's visual treatment, and shipping a trademark to decorate a
 * placeholder is not something a sample card needs.
 */
function SampleJobCard() {
  return (
    <div className="rounded-xl border border-border bg-surface p-3.5 shadow-e3 lg:absolute lg:top-0 lg:left-[32%] lg:z-20 lg:w-[28%] lg:min-w-[14rem] lg:p-3 xl:left-[35%] 2xl:left-[38%]">
      <p className="text-[11px] font-semibold tracking-label text-subtle-foreground uppercase">
        Sample listing
      </p>

      <div className="mt-2 flex items-start gap-2.5">
        <span
          aria-hidden="true"
          className="grid size-9 shrink-0 place-items-center rounded-md border border-border bg-surface"
        >
          <BrandRing />
        </span>
        <div className="min-w-0">
          <p className="truncate text-[15px] font-semibold text-foreground">Sr. UI/UX Designer</p>
          <p className="truncate text-[13px] text-muted-foreground">Google</p>
        </div>
      </div>

      <dl className="mt-2 grid grid-cols-2 gap-x-2.5 gap-y-1.5 border-t border-border pt-2 text-[13px] text-muted-foreground">
        <div className="flex min-w-0 items-center gap-1.5">
          <dt className="sr-only">Location</dt>
          <MapPin className="size-3.5 shrink-0" aria-hidden="true" />
          <dd className="truncate">California</dd>
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <dt className="sr-only">Employment type</dt>
          <Briefcase className="size-3.5 shrink-0" aria-hidden="true" />
          <dd className="truncate">Full-time</dd>
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <dt className="sr-only">Work mode</dt>
          <MapPin className="size-3.5 shrink-0 opacity-0" aria-hidden="true" />
          <dd className="truncate">Remote</dd>
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <dt className="sr-only">Pay</dt>
          <Wallet className="size-3.5 shrink-0" aria-hidden="true" />
          <dd className="truncate font-semibold text-foreground">$3K–$5K / mo</dd>
        </div>
      </dl>
    </div>
  );
}

/** A four-quarter ring in the familiar blue/red/amber/green, drawn rather than shipped. */
function BrandRing() {
  /* r=9 -> circumference 56.55, so each quarter is 14.14 of dash against the rest
     as gap, offset a quarter-turn further round than the one before it. */
  const quarter = (2 * Math.PI * 9) / 4;
  const colors = ["#4285f4", "#ea4335", "#fbbc05", "#34a853"];

  return (
    <svg viewBox="0 0 24 24" className="size-[1.15rem]" aria-hidden="true">
      <g transform="rotate(-90 12 12)">
        {colors.map((color, index) => (
          <circle
            key={color}
            cx="12"
            cy="12"
            r="9"
            fill="none"
            stroke={color}
            strokeWidth="5"
            strokeDasharray={`${quarter} ${quarter * 3}`}
            strokeDashoffset={-quarter * index}
          />
        ))}
      </g>
    </svg>
  );
}

/**
 * The floating pill the reference puts between the two cutouts.
 *
 * A real link rather than a decorative badge — it goes to the feed, which is where
 * applying starts, and every posting there keeps its original apply link. Hidden
 * below lg: it has no room on a phone, and the search button and the notify band's
 * CTA already cover the same ground there.
 */
function ApplyPill() {
  return (
    <Link
      href="/jobs"
      className="hidden rounded-full bg-surface py-3 pr-5 pl-5 text-[15px] font-semibold text-primary-strong shadow-e3 transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-e3 lg:absolute lg:top-[48%] lg:left-[49%] lg:z-20 lg:inline-flex lg:items-center lg:gap-2 xl:top-[46%] 2xl:top-[42%]"
    >
      Apply for job
      <ArrowRight className="size-4" aria-hidden="true" />
    </Link>
  );
}

/**
 * The ring card, in the position the reference gives "93% Qualified".
 *
 * There is no qualification score to show an anonymous visitor — match scores are
 * computed against an uploaded resume and live on /recommended-jobs — so the ring
 * carries a figure the feed does report instead: the share of postings that
 * arrived in the last seven days.
 */
function FreshRing({ share }: { share: number }) {
  /* r=26 → circumference 163.36. The arc is drawn as a dash of the right length
     against a full-circle gap, which is what makes one <circle> a progress ring. */
  const circumference = 2 * Math.PI * 26;
  const filled = (Math.min(Math.max(share, 0), 100) / 100) * circumference;

  return (
    <div className="rounded-xl border border-border bg-surface p-4 text-center shadow-e3 sm:w-[11.5rem] lg:absolute lg:bottom-[18%] lg:left-[-2%] lg:z-20 lg:w-[21%] lg:min-w-[9rem] lg:scale-90">
      <p className="text-sm font-semibold text-foreground">Fresh this week</p>

      <span className="relative mx-auto mt-3 block size-[4.5rem]">
        <svg viewBox="0 0 60 60" className="size-full -rotate-90" aria-hidden="true">
          <circle cx="30" cy="30" r="26" fill="none" stroke="var(--color-muted)" strokeWidth="7" />
          <circle
            cx="30"
            cy="30"
            r="26"
            fill="none"
            stroke="var(--color-primary)"
            strokeWidth="7"
            strokeLinecap="round"
            strokeDasharray={`${filled} ${circumference}`}
          />
        </svg>
        <span className="absolute inset-0 grid place-items-center font-heading text-base leading-none font-bold text-foreground tabular-nums">
          {share}%
        </span>
      </span>

      <p className="mt-3 text-xs leading-relaxed text-subtle-foreground">
        of the feed was posted in the last 7 days
      </p>
    </div>
  );
}

/** The dark pill, where the reference puts its total-applications badge. */
function LiveCountPill({ total }: { total: number }) {
  return (
    <div className="inline-flex items-center gap-2.5 self-start justify-self-center rounded-full bg-inverse py-2.5 pr-5 pl-2.5 shadow-e3 sm:col-span-2 lg:absolute lg:bottom-[21%] lg:left-[42%] lg:z-20">
      <span
        aria-hidden="true"
        className="grid size-8 shrink-0 place-items-center rounded-full bg-inverse-elevated text-primary-bright"
      >
        <Briefcase className="size-4" />
      </span>
      <span className="text-sm font-semibold text-on-inverse tabular-nums">
        {total.toLocaleString("en-US")} {total === 1 ? "job" : "jobs"} live right now
      </span>
    </div>
  );
}

/**
 * The band the reference fills with an email capture.
 *
 * There is no mailing list in this project — no subscribers collection, no send
 * path, nothing that would receive an address — so an email field here would be a
 * box that silently discards what is typed into it. The band keeps its shape and
 * its promise, and the button leads to the thing that genuinely does deliver
 * matched jobs: an account with a resume on it, which is what
 * `/recommended-jobs` reads.
 */
function NotifyBand() {
  return (
    <div className="mt-6 flex flex-col gap-4 rounded-xl border border-border bg-surface/70 p-4 sm:mt-7 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:p-5 lg:-mt-20 lg:px-6 lg:py-5">
      <div className="flex items-start gap-3 lg:gap-3.5">
        <span
          aria-hidden="true"
          className="grid size-10 shrink-0 place-items-center rounded-full bg-primary-soft text-primary-strong"
        >
          <BellRing className="size-5" />
        </span>
        <p className="font-heading text-lg leading-snug font-semibold tracking-snug text-foreground sm:text-xl lg:text-lg">
          Get notified about every suitable job
          <span className="mt-1 block font-body text-[15px] leading-relaxed font-normal tracking-normal text-muted-foreground lg:text-[14px]">
            Upload your resume once and we match new postings to it.
          </span>
        </p>
      </div>

      <Link
        href={SIGN_UP_PATH}
        className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-full bg-primary px-5 text-[15px] font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow,transform] duration-150 hover:bg-primary-strong hover:shadow-e2 active:scale-[0.98] lg:min-h-10"
      >
        Create account
        <ArrowRight className="size-4" aria-hidden="true" />
      </Link>
    </div>
  );
}
