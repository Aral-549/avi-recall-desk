import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { Chakra_Petch, Figtree, Gochi_Hand, Unbounded } from 'next/font/google'
import './globals.css'

const interfaceFont = Figtree({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-interface' })
const displayFont = Unbounded({ subsets: ['latin'], weight: ['400', '500', '700'], variable: '--font-display' })
const labelFont = Chakra_Petch({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-label' })
const handFont = Gochi_Hand({ subsets: ['latin'], weight: '400', variable: '--font-hand' })

export const metadata: Metadata = {
  title: 'AVI — Recall Desk',
  description: 'A personal archive that brings useful saved things back when you return to the work.',
  applicationName: 'AVI',
  icons: {
    icon: [
      {
        url: '/icon-light-32x32.png',
        media: '(prefers-color-scheme: light)',
      },
      {
        url: '/icon-dark-32x32.png',
        media: '(prefers-color-scheme: dark)',
      },
      {
        url: '/icon.svg',
        type: 'image/svg+xml',
      },
    ],
    apple: '/apple-icon.png',
  },
}

export const viewport: Viewport = {
  colorScheme: 'light',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f4efe4' },
  ],
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={`${interfaceFont.variable} ${displayFont.variable} ${labelFont.variable} ${handFont.variable}`}>
      <body className="antialiased">
        {children}
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}

