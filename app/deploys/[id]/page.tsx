import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { isAuthed } from "@/lib/auth";
import { getServer } from "@/lib/server";
import { LogViewer } from "@/components/LogViewer";
import type { DeployDetail } from "@/components/DeploySummary";

export const dynamic = "force-dynamic";

export default async function DeployPage(
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await isAuthed())) redirect("/login");

  const { id } = await params;
  const deploy = getServer().db.getDeploy(id);
  if (!deploy) notFound();

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-6">
      <Link href="/" className="text-xs text-[var(--muted)] hover:text-[var(--text)]">
        ← Semua deployment
      </Link>
      <LogViewer initial={deploy as unknown as DeployDetail} />
    </main>
  );
}
