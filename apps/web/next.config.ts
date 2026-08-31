import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* The recommendations page lives at /recommended-jobs. This keeps the earlier
     /recommended path working, so a bookmark or an open tab on it still lands on
     the page rather than a 404. Not permanent: a 308 would be cached by the
     browser and outlive the rename. */
  async redirects() {
    return [{ source: "/recommended", destination: "/recommended-jobs", permanent: false }];
  },
};

export default nextConfig;
