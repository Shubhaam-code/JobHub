/**
 * Renders post text with its URLs and email addresses turned into real links.
 *
 * The detection lives in `linkifyText`, so nothing here invents a destination:
 * an email becomes `mailto:`, an http(s) URL is used verbatim, and anything that
 * is not one of those stays plain text. Output is a fragment of text nodes and
 * inline anchors — no wrapper element — so it drops into an existing paragraph
 * or `whitespace-pre-wrap` block without changing its layout.
 */

import { Fragment } from "react";

import { linkifyText } from "@/lib/links";

/**
 * Matches the in-content link style already used for the contact email on the
 * job detail page. `break-words` keeps a long apply URL from overflowing the
 * card it sits in.
 */
const LINK_CLASS =
  "font-medium text-primary underline decoration-primary/35 underline-offset-2 break-words hover:text-primary-strong hover:decoration-primary";

export function LinkifiedText({ text }: { text: string | null | undefined }) {
  if (!text) return null;

  return (
    <>
      {linkifyText(text).map((segment, index) =>
        segment.type === "link" ? (
          <a
            key={index}
            href={segment.href}
            // The visible URL/address stays the accessible name; the label only
            // adds where the link goes.
            aria-label={
              segment.kind === "email"
                ? `Email ${segment.text}`
                : `${segment.text} (opens in a new tab)`
            }
            {...(segment.kind === "email" ? {} : { target: "_blank", rel: "noopener noreferrer" })}
            className={LINK_CLASS}
          >
            {segment.text}
          </a>
        ) : (
          <Fragment key={index}>{segment.text}</Fragment>
        ),
      )}
    </>
  );
}
