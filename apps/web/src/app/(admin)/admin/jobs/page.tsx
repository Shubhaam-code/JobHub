import type { Metadata } from "next";

import { AdminGate } from "@/components/admin-gate";
import { AdminJobsTable } from "@/components/admin-jobs-table";

export const metadata: Metadata = {
  title: "Manage jobs",
};

export default function Page() {
  return (
    <AdminGate>
      <AdminJobsTable />
    </AdminGate>
  );
}
