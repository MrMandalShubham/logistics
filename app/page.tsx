import { redirect } from "next/navigation";
import { currentClaims } from "@/lib/auth/current";

export const dynamic = "force-dynamic";

/**
 * The front door, which is now a doorway rather than a room.
 *
 * It used to be a tile menu of every screen, because nothing else
 * linked between them. The staff shell has a persistent bar now, so a
 * page whose only job is to list the same links again is a stop on
 * the way to somewhere — and everybody who lands here wants the
 * dispatch board.
 *
 * Riders go to their jobs. A rider on a doorstep opening a menu is a
 * rider not delivering anything.
 */
export default async function Home() {
  const claims = await currentClaims();

  if (!claims) redirect("/sign-in");
  if (claims.must_change_password) redirect("/change-password");

  redirect(claims.role === "rider" ? "/me" : "/dispatch");
}
