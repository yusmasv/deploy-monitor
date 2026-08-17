import { requireAuth } from "@/lib/auth";
import { getServer } from "@/lib/server";
import { stripAnsi } from "@/lib/phases";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { id } = await ctx.params;
  const plain = new URL(req.url).searchParams.get("plain") === "1";
  const lines = getServer().db.getLines(id, 0);

  const body = lines.map((l) => (plain ? stripAnsi(l.text) : l.text)).join("\n");
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename="deploy-${id}.log"`,
    },
  });
}
