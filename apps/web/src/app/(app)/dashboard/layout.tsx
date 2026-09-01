import { DashboardShell } from "@/components/dashboard-shell";

export const metadata = {
  title: "Dashboard",
  description: "Manage your resume and preferences, and see the jobs that match them.",
};

export default function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  return <DashboardShell>{children}</DashboardShell>;
}
