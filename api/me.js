import { currentUser } from "../lib/session.js";

export async function GET(request) {
  const user = await currentUser(request);
  if (!user) return Response.json({ error: "signed_out" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  return Response.json({ email: user.email, name: user.name }, { headers: { "Cache-Control": "no-store" } });
}
