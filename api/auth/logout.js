import { cookie, SESSION_COOKIE } from "../../lib/session.js";
import { page } from "../../lib/pages.js";

export async function GET() {
  return page(200, "Signed out",
    `<p>You are signed out of the FREITTY dashboard.</p><p><a class="btn" href="/api/auth/login">Sign in again</a></p>`,
    { "Set-Cookie": cookie(SESSION_COOKIE, "", { maxAge: 0 }) });
}
