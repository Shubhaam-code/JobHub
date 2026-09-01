import type { Metadata } from "next";

import { AdminGate } from "@/components/admin-gate";
import { AdminOverview } from "@/components/admin-overview";

export const metadata: Metadata = {
  title: "Admin dashboard",
};

export default function Page() {
  return (
    <AdminGate>
      <AdminOverview />
    </AdminGate>
  );
}
