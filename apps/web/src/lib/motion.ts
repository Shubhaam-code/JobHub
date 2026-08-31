/* Shared motion vocabulary for the homepage.
   ui-ux-pro-max --domain ux "animation duration easing consistency" returns two
   rules that shape this file:

   - Duration Timing: "Don't present 150-300ms or any cutoff as a universal
     requirement" and "Don't copy one duration to every transition." So the
     durations below are graded by how far the element travels and how much of
     the screen it changes, not set to a single house value.
   - Easing: decelerate on arrival, accelerate on departure. EASE_OUT is used
     for everything entering or settling; exits run at ~65% of their entrance
     so dismissal feels immediate rather than reluctant. */

/** Decelerating curve for anything arriving or settling into place. */
export const EASE_OUT: [number, number, number, number] = [0.22, 1, 0.36, 1];

/** Accelerating curve for anything leaving. */
export const EASE_IN: [number, number, number, number] = [0.4, 0, 1, 1];

export const DURATION = {
  /** 140ms — presses and colour/border swaps. Should feel instantaneous. */
  press: 0.14,
  /** 220ms — state changes that move a small element: tab pill, focus ring. */
  state: 0.22,
  /** 320ms — entrances that travel: hero lines, cards, the mobile nav sheet. */
  enter: 0.32,
  /** 200ms — exits. Deliberately shorter than the matching entrance. */
  exit: 0.2,
} as const;

/** Cards rise in sequence, but the tail is capped so the last card in a full
    grid is never left waiting on the first eight. */
export const LIST_STAGGER = 0.045;
export const LIST_MAX_DELAY = 0.22;
