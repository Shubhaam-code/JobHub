import { FileText, LogIn, Send, Sparkles } from "lucide-react";

/**
 * What the "How it works" nav item points at.
 *
 * Four steps, and each one is a feature that exists: Clerk sign-up, the resume
 * upload on the dashboard, the match scoring behind /recommended-jobs, and the
 * apply link the ingestion pipeline stores on every posting. Nothing here
 * describes a capability the project does not have.
 */
const STEPS = [
  {
    icon: LogIn,
    title: "Create your account",
    body: "Sign up with an email address or a Google account. That is the whole form.",
  },
  {
    icon: FileText,
    title: "Upload your resume",
    body: "One PDF from your dashboard. It is what every match below is scored against.",
  },
  {
    icon: Sparkles,
    title: "Get matched postings",
    body: "Recommended jobs are ranked against your resume, batch and preferred role.",
  },
  {
    icon: Send,
    title: "Apply at the source",
    body: "Every posting keeps its original apply link, so you go straight to the employer.",
  },
];

export function WelcomeHowItWorks() {
  return (
    /* `scroll-mt` clears the section heading from under the nav when the anchor is
       followed — the bar is not sticky here, but the smooth scroll in globals.css
       still lands tight against the top edge without it. */
    <section
      id="how-it-works"
      aria-labelledby="how-it-works-heading"
      className="scroll-mt-8 border-t border-border bg-surface"
    >
      <div className="mx-auto w-full max-w-[88rem] px-4 py-14 sm:px-6 lg:px-8 lg:py-20">
        <div className="max-w-2xl">
          <span className="text-[11px] font-semibold tracking-label text-primary-strong uppercase">
            How it works
          </span>
          <h2
            id="how-it-works-heading"
            className="mt-3 font-heading text-3xl leading-tight font-semibold tracking-display text-foreground sm:text-4xl"
          >
            From signing up to applying, in four steps
          </h2>
        </div>

        <ol className="mt-10 grid gap-6 sm:grid-cols-2 lg:mt-12 lg:grid-cols-4 lg:gap-5">
          {STEPS.map((step, index) => (
            <li
              key={step.title}
              className="rounded-xl border border-border bg-background p-5 transition-[border-color,box-shadow] duration-150 hover:border-border-strong hover:shadow-e1"
            >
              <span className="flex items-center gap-3">
                <span
                  aria-hidden="true"
                  className="grid size-10 shrink-0 place-items-center rounded-md bg-primary-soft text-primary-strong"
                >
                  <step.icon className="size-5" />
                </span>
                <span className="font-heading text-sm leading-none font-semibold text-subtle-foreground tabular-nums">
                  {String(index + 1).padStart(2, "0")}
                </span>
              </span>

              <h3 className="mt-4 font-heading text-base leading-snug font-semibold tracking-snug text-foreground">
                {step.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
