import type { ReactNode } from 'react';
import { PlatformShell } from '@/features/m1/shell';

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <PlatformShell>{children}</PlatformShell>;
}
