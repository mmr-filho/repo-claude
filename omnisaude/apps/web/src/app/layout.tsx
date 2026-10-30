import type { Metadata, Viewport } from 'next';
import { ToastProvider } from '@/components/ui/toast';
import { SessionProvider } from '@/lib/session';
import './globals.css';

export const metadata: Metadata = {
  title: 'OmniSaúde',
  description: 'Gestão integrada da rede pública de saúde: atenção primária, urgência, hospital, farmácia e faturamento SUS.',
  applicationName: 'OmniSaúde',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#1567ed',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body className="min-h-dvh">
        <ToastProvider>
          <SessionProvider>{children}</SessionProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
