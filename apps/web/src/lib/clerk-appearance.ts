import type { ComponentProps } from "react";
import type { SignIn } from "@clerk/nextjs";

type ClerkAppearance = NonNullable<ComponentProps<typeof SignIn>["appearance"]>;

/**
 * Lets Clerk's widget sit inside our own `AuthCard` instead of drawing a second
 * card inside the first one.
 *
 * The first attempt at this passed Tailwind class strings through
 * `appearance.elements`, and it did not work: Clerk injects its own styles at
 * runtime, and against Tailwind v4's layered utilities its rules win the cascade —
 * so the card kept its border and the header kept its heading. Clerk 7 supports
 * both of those removals directly, which is what this uses:
 *
 *   - `elevation: "flush"` is Clerk's own name for "sit flat in your container":
 *     it drops the card border, shadow, radius, outer padding and footer
 *     background. That is the double-card fix, done by the library rather than
 *     fought with CSS.
 *   - `logoPlacement: "none"` because `AuthCard` already shows our mark above the
 *     heading; Clerk would otherwise add the one from its dashboard.
 *   - `unsafe_disableDevelopmentModeWarnings` removes the "Development mode"
 *     ribbon, which is a Clerk-instance detail rather than something a visitor
 *     should be reading. It has no effect on a production instance.
 *
 * `elements` is down to what those options cannot express: the widget's width, and
 * hiding its own heading because `AuthCard` renders the heading. These are style
 * objects, not classes — Clerk applies them through its own styling layer, so they
 * land after its base rules instead of losing to them.
 *
 * Nothing here touches the fields, the buttons, the social buttons or the error
 * states. If a future release renames a key the affected chrome simply comes back:
 * a cosmetic regression, never a broken form. Colour, radius and type face still
 * come from the `variables` set once on `ClerkProvider`.
 */
export const EMBEDDED_CLERK_APPEARANCE: ClerkAppearance = {
  options: {
    elevation: "flush",
    logoPlacement: "none",
    unsafe_disableDevelopmentModeWarnings: true,
  },
  elements: {
    /* `elevation: "flush"` drops the widget's card chrome but not its width: it is
       still laid out as a card of its own, which is wider than `AuthCard`'s content
       box — so the Google button, the email field and the submit button ran past
       the card's right edge. Fluid instead, because the width is `AuthCard`'s to
       decide. All three levels are set: Clerk nests rootBox > cardBox > card, and a
       fixed width on any one of them is enough to overflow. */
    rootBox: { width: "100%" },
    cardBox: { width: "100%", maxWidth: "100%" },
    card: { width: "100%", maxWidth: "100%" },
    /* Ours says it already — see the `title`/`subtitle` passed to `AuthCard`. */
    header: { display: "none" },
    /* With the header gone the form would otherwise start against the tabs. */
    main: { marginTop: 0 },
    /* "Don't have an account? Sign up" — kept, it is in the reference design, but
       flush against the form rather than in its own shaded strip. */
    footer: { paddingLeft: 0, paddingRight: 0 },
  },
};
