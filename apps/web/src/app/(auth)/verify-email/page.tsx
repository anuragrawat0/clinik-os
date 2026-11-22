import { VerifyEmailForm } from '@/components/auth/verify-email-form';

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const { token } = await searchParams;
  return <VerifyEmailForm token={typeof token === 'string' ? token : undefined} />;
}
