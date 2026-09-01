import { HomeLanding } from "@/components/home-landing";

export const metadata = {
  title: "Find your dream job",
  description:
    "Search every opening in the feed by role, company or location, and apply straight at the source.",
};

/* Header, <main> and footer come from the (app) layout, which every page shares. */
export default function Page() {
  return <HomeLanding />;
}
