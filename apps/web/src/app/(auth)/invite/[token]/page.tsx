import { InvitationForm } from '@/components/auth/invitation-form';

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <InvitationForm token={token} />;
}
