import type { Metadata } from "next";

import { AdminChannels } from "@/components/admin-channels";
import { AdminGate } from "@/components/admin-gate";

export const metadata: Metadata = {
  title: "Channels",
};

export default function Page() {
  return (
    <AdminGate>
      <AdminChannels />
    </AdminGate>
  );
}
