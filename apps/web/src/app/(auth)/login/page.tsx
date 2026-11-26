import { AuthForm } from '@/components/auth/auth-form';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;
  return <AuthForm mode="login" sessionEnded={reason === 'session-ended'} />;
}
