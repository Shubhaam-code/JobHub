import { redirect } from "next/navigation";

/**
 * The old resume-and-preferences page.
 *
 * Both halves now live in the dashboard — the upload on `/dashboard/resume` and
 * the preference form on `/dashboard/profile`. This route stays as a redirect
 * because links to it exist (the recommendations page, and anything a user
 * bookmarked), and preferences is the half someone arriving here wanted.
 */
export default function ProfilePage() {
  redirect("/dashboard/profile");
}
