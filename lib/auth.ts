import { cookies } from "next/headers";
import { getConfig } from "./config";
import { COOKIE_NAME, tokenMatches } from "./token";

export { COOKIE_NAME, tokenMatches };

export async function isAuthed(): Promise<boolean> {
  const jar = await cookies();
  const given = jar.get(COOKIE_NAME)?.value ?? "";
  return tokenMatches(getConfig().monitorToken, given);
}

export async function requireAuth(): Promise<Response | null> {
  if (await isAuthed()) return null;
  return Response.json({ error: "Tidak terautentikasi." }, { status: 401 });
}
