import Link from 'next/link';

export default function InvitePage() {
  return (
    <>
      <h1 id="auth-title">Accept invitation</h1>
      <p role="alert" className="auth-error">
        This invitation is unavailable.
      </p>
      <Link href="/login">Back to sign in</Link>
    </>
  );
}
