import type { ReactNode } from 'react';
import { ClinicShell } from '@/features/m1/shell';

export default async function ClinicLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  return (
    <ClinicShell key={orgSlug} slug={orgSlug}>
      {children}
    </ClinicShell>
  );
}
