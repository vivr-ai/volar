import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AccountSettingsForm } from "./account-settings-form";

// Issue 2.5 (Epic 2): minimal Account Settings page — email/password
// change using default Supabase Auth flows only (PRD §US-5.3 AC1).
// Epic 16 rebuilds this into the full designed "Account / API Key
// Management" screen; this page establishes the underlying logic.
export default async function AccountPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const user = data?.claims;

  // The proxy (issue 2.4) already blocks unauthenticated /app/* requests,
  // but per Supabase's guidance, pages that handle user data should
  // independently verify too rather than rely solely on the proxy.
  if (!user?.email) {
    redirect("/sign-in");
  }

  return (
    <main className="mx-auto max-w-lg px-6 py-12">
      <h1 className="mb-8 text-2xl font-semibold">Account</h1>
      <AccountSettingsForm currentEmail={user.email} />
    </main>
  );
}
