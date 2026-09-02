import { redirect } from "next/navigation";

// nav-ok: not a screen. #1748 broke this hub into the sections it used to stack,
// each with its own sidebar entry; this stays only so an old bookmark or an old
// Slack link still lands somewhere real instead of 404ing.
export default function SettingsRedirect() {
  redirect("/admin");
}
