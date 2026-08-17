import { redirect } from "next/navigation";
import { isAuthed } from "@/lib/auth";
import { getServer } from "@/lib/server";
import { DeployList } from "@/components/DeployList";
import { UploadForm } from "@/components/UploadForm";

export const dynamic = "force-dynamic";

export default async function Home() {
  if (!(await isAuthed())) redirect("/login");
  const deploys = getServer().db.listDeploys(50);

  return (
    <main className="mx-auto grid max-w-5xl gap-6 p-6 md:grid-cols-[1fr_320px]">
      <section className="order-2 md:order-1">
        <h2 className="mb-2 text-sm font-medium text-[var(--muted)]">Riwayat deployment</h2>
        <DeployList deploys={deploys} />
      </section>
      <section className="order-1 md:order-2">
        <h1 className="mb-2 text-sm font-medium text-[var(--muted)]">Deploy baru</h1>
        <UploadForm />
      </section>
    </main>
  );
}
