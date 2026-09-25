import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/pocketbase/auth";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const user = await getCurrentUser();
  redirect(user ? "/today" : "/login");
}
