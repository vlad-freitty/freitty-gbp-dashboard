// End the dashboard session. The Microsoft session stays, so the next sign-in is one click.
import { cookie, SESSION_COOKIE } from "../../lib/session.js";
import { landing } from "../../lib/pages.js";

export async function GET() {
  return landing({
    title: "Ви вийшли з дашборда", tone: "ok",
    note: "Сесію в дашборді завершено. Щоб повернутися, увійдіть знову.",
    headers: { "Set-Cookie": cookie(SESSION_COOKIE, "", { maxAge: 0 }) },
  });
}
