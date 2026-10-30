'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Spinner } from '@/components/ui/misc';
import { useSession } from '@/lib/session';

export default function Index() {
  const { me, loading } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (!loading) router.replace(me ? '/inicio' : '/login');
  }, [me, loading, router]);
  return <Spinner className="min-h-dvh" />;
}
