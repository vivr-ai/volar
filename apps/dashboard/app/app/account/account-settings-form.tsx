"use client";

import { useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";

type Status = { type: "idle" | "success" | "error"; message?: string };

// Known limitation (acceptable for this minimal issue 2.5 page, per PRD
// §US-5.3 AC1 "no custom requirements beyond default Supabase Auth
// flows"): a magic-link-only user (no password ever set) will always see
// "Current password is incorrect" when attempting a password change,
// since signInWithPassword has nothing to verify against. Epic 16.5's
// full designed screen is a reasonable place to detect the user's auth
// provider and hide/adjust this form accordingly.
export function AccountSettingsForm({
  currentEmail,
}: {
  currentEmail: string;
}) {
  const supabase = createClient();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordStatus, setPasswordStatus] = useState<Status>({
    type: "idle",
  });
  const [passwordSubmitting, setPasswordSubmitting] = useState(false);

  const [newEmail, setNewEmail] = useState("");
  const [emailStatus, setEmailStatus] = useState<Status>({ type: "idle" });
  const [emailSubmitting, setEmailSubmitting] = useState(false);

  async function handlePasswordChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPasswordSubmitting(true);
    setPasswordStatus({ type: "idle" });

    // Re-verify the current password before allowing a change. Supabase's
    // updateUser() trusts the active session alone and doesn't ask for
    // the current password, so this re-auth step (a standard Supabase
    // Auth method, not custom backend logic) is what produces a genuine
    // "wrong current password" error.
    const { error: reauthError } = await supabase.auth.signInWithPassword({
      email: currentEmail,
      password: currentPassword,
    });

    if (reauthError) {
      setPasswordStatus({
        type: "error",
        message: "Current password is incorrect.",
      });
      setPasswordSubmitting(false);
      return;
    }

    const { error } = await supabase.auth.updateUser({
      password: newPassword,
    });

    if (error) {
      setPasswordStatus({ type: "error", message: error.message });
    } else {
      setPasswordStatus({ type: "success", message: "Password updated." });
      setCurrentPassword("");
      setNewPassword("");
    }
    setPasswordSubmitting(false);
  }

  async function handleEmailChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEmailSubmitting(true);
    setEmailStatus({ type: "idle" });

    const { error } = await supabase.auth.updateUser({ email: newEmail });

    if (error) {
      setEmailStatus({ type: "error", message: error.message });
    } else {
      setEmailStatus({
        type: "success",
        message: `Check ${newEmail} to confirm this change — your email won't update until confirmed.`,
      });
      setNewEmail("");
    }
    setEmailSubmitting(false);
  }

  return (
    <div className="flex flex-col gap-10">
      <section>
        <h2 className="mb-3 text-lg font-medium">Change password</h2>
        <form onSubmit={handlePasswordChange} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            Current password
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
              className="rounded border px-3 py-2"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            New password
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              minLength={8}
              className="rounded border px-3 py-2"
            />
          </label>
          <button
            type="submit"
            disabled={passwordSubmitting}
            className="self-start rounded bg-black px-4 py-2 text-white disabled:opacity-50"
          >
            {passwordSubmitting ? "Updating…" : "Update password"}
          </button>
          {passwordStatus.type === "error" && (
            <p role="alert" className="text-sm text-red-600">
              {passwordStatus.message}
            </p>
          )}
          {passwordStatus.type === "success" && (
            <p role="status" className="text-sm text-green-700">
              {passwordStatus.message}
            </p>
          )}
        </form>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium">Change email</h2>
        <p className="mb-3 text-sm text-gray-600">
          Current email: {currentEmail}
        </p>
        <form onSubmit={handleEmailChange} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            New email
            <input
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              required
              className="rounded border px-3 py-2"
            />
          </label>
          <button
            type="submit"
            disabled={emailSubmitting}
            className="self-start rounded bg-black px-4 py-2 text-white disabled:opacity-50"
          >
            {emailSubmitting ? "Updating…" : "Update email"}
          </button>
          {emailStatus.type === "error" && (
            <p role="alert" className="text-sm text-red-600">
              {emailStatus.message}
            </p>
          )}
          {emailStatus.type === "success" && (
            <p role="status" className="text-sm text-green-700">
              {emailStatus.message}
            </p>
          )}
        </form>
      </section>
    </div>
  );
}
