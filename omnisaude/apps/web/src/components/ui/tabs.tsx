'use client';

import { Tabs as T } from 'radix-ui';
import { cn } from '@/lib/cn';

export function Tabs({ value, onValueChange, tabs, children, className }: { value: string; onValueChange: (v: string) => void; tabs: { value: string; label: React.ReactNode }[]; children: React.ReactNode; className?: string }) {
  return (
    <T.Root value={value} onValueChange={onValueChange} className={className}>
      <T.List className="mb-4 flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1" aria-label="Seções">
        {tabs.map((t) => (
          <T.Trigger
            key={t.value}
            value={t.value}
            className={cn('rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors data-[state=active]:bg-white data-[state=active]:text-slate-900 data-[state=active]:shadow-sm')}
          >
            {t.label}
          </T.Trigger>
        ))}
      </T.List>
      {children}
    </T.Root>
  );
}

export const TabPanel = T.Content;
