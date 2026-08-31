"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Search, X } from "lucide-react";

import { SEARCH_SUGGESTIONS } from "@/lib/opportunities";
import { DURATION, EASE_IN, EASE_OUT } from "@/lib/motion";

const INPUT_ID = "opportunity-search";

interface OpportunitySearchProps {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
}

/**
 * The page's primary interaction, built as one elevated surface rather than an
 * input sitting next to a button.
 *
 * ui-ux-pro-max --domain ux "search input focus state" returns Input Labels at
 * severity High — "Always show label above or beside input", "Don't: Placeholder
 * as only label". Phase 1 had an sr-only label and leaned on the placeholder,
 * so the label is now visible above the field and the placeholder does the
 * separate job of naming what is searchable.
 */
export function OpportunitySearch({ value, onValueChange, onSubmit }: OpportunitySearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const reduceMotion = useReducedMotion();

  /* "/" moves focus to the field. Real behaviour, which is what makes the hint
     rendered below honest rather than decoration. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return;
      }
      event.preventDefault();
      inputRef.current?.focus();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    /* Dismiss the on-screen keyboard before scrolling, so the results the
       submit is scrolling to are actually on screen when it lands. */
    inputRef.current?.blur();
    onSubmit();
  };

  return (
    <form role="search" onSubmit={handleSubmit} className="mx-auto max-w-2xl">
      {/* Focus is signalled on the whole shell — primary hairline (5.9:1
          against both adjoining surfaces), a soft ring and a deeper shadow —
          rather than with an outline around the bare input, which would sit
          inside the container and read as a defect. */}
      <div
        className={`rounded-xl border bg-surface p-2 transition-[border-color,box-shadow] duration-200 ${
          focused
            ? "border-primary shadow-e3 ring-2 ring-primary/20"
            : "border-border shadow-e2 hover:border-border-strong"
        }`}
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 items-center gap-3 px-3 py-0.5 sm:pr-1">
            <Search
              className={`size-5 shrink-0 transition-colors duration-150 ${
                focused ? "text-primary" : "text-subtle-foreground"
              }`}
              aria-hidden="true"
            />

            {/* The label wraps the input rather than sitting beside it, so the
                whole 48px block — micro-label included — is one tap target that
                forwards focus to the field. A 24px-tall bare input would be
                under the 44px minimum on touch even though the surrounding
                surface looks tappable. */}
            <label htmlFor={INPUT_ID} className="block min-w-0 flex-1 cursor-text py-1 text-left">
              <span className="block text-[11px] font-semibold tracking-label text-subtle-foreground uppercase">
                Search opportunities
              </span>
              <input
                ref={inputRef}
                id={INPUT_ID}
                type="search"
                value={value}
                onChange={(event) => onValueChange(event.target.value)}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                placeholder="Role, company, city or batch"
                autoComplete="off"
                className="w-full bg-transparent text-base leading-6 text-foreground outline-none placeholder:text-subtle-foreground"
              />
            </label>

            <AnimatePresence initial={false}>
              {value && (
                <motion.button
                  type="button"
                  onClick={() => {
                    onValueChange("");
                    inputRef.current?.focus();
                  }}
                  aria-label="Clear search"
                  initial={reduceMotion ? false : { opacity: 0, scale: 0.85 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={
                    reduceMotion
                      ? { opacity: 0 }
                      : {
                          opacity: 0,
                          scale: 0.85,
                          transition: {
                            duration: DURATION.press,
                            ease: EASE_IN,
                          },
                        }
                  }
                  transition={{ duration: DURATION.state, ease: EASE_OUT }}
                  className="grid size-11 shrink-0 place-items-center rounded-md text-subtle-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
                >
                  <X className="size-4" aria-hidden="true" />
                </motion.button>
              )}
            </AnimatePresence>

            {/* Shown only where a physical keyboard is likely, and only while
                the shortcut would actually do something. */}
            <AnimatePresence initial={false}>
              {!value && !focused && (
                <motion.kbd
                  initial={reduceMotion ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{
                    opacity: 0,
                    transition: { duration: DURATION.press },
                  }}
                  transition={{ duration: DURATION.state }}
                  className="hidden shrink-0 rounded-sm border border-border bg-muted px-1.5 py-0.5 font-body text-xs text-subtle-foreground sm:block"
                >
                  /
                </motion.kbd>
              )}
            </AnimatePresence>
          </div>

          <button
            type="submit"
            className="inline-flex h-12 w-full shrink-0 items-center justify-center gap-2 rounded-md bg-primary px-6 text-[15px] font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow,transform] duration-150 hover:bg-primary-strong hover:shadow-e2 active:scale-[0.98] sm:w-auto"
          >
            <Search className="size-4 sm:hidden" aria-hidden="true" />
            Search
          </button>
        </div>
      </div>

      {/* Real shortcuts into the same local filter, not decorative tags.

          The height floor is gated on `pointer-fine` rather than on a breakpoint:
          touch density should follow the input device, not the viewport. A 768px
          tablet is touch and keeps the 44px target; a narrow desktop window has a
          mouse and gets the tighter 36px that reads more refined. Every control
          on the page uses this same rule. */}
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <span className="text-sm text-subtle-foreground">Try</span>
        {SEARCH_SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => onValueChange(suggestion)}
            className="inline-flex min-h-11 items-center rounded-md border border-border bg-surface px-3 text-[13px] font-medium text-muted-foreground transition-colors duration-150 hover:border-border-strong hover:bg-muted hover:text-foreground pointer-fine:min-h-9"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </form>
  );
}
