import { requireAuth } from "@/lib/auth";
import { getServer } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { id } = await ctx.params;
  const deploy = getServer().db.getDeploy(id);
  if (!deploy) return Response.json({ error: "Deploy tidak ditemukan." }, { status: 404 });
  return Response.json({ deploy });
}
