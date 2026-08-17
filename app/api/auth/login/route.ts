import { cookies } from "next/headers";
import { getConfig } from "@/lib/config";
import { COOKIE_NAME, tokenMatches } from "@/lib/auth";

export async function POST(req: Request) {
  const { token } = (await req.json()) as { token?: string };
  if (!token || !tokenMatches(getConfig().monitorToken, token)) {
    return Response.json({ error: "Token salah." }, { status: 401 });
  }
  const jar = await cookies();
  jar.set(COOKIE_NAME, token, {
    httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30,
  });
  return Response.json({ ok: true });
}
