import { PlatformOrganization } from '@/features/m1/platform';

export default async function OrganizationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PlatformOrganization key={id} id={id} />;
}
