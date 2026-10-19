import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { Cabin_Sketch, Cutive_Mono, Figtree, Reenie_Beanie } from 'next/font/google'
import './globals.css'

const interfaceFont = Figtree({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-interface' })
const sketchDisplayFont = Cabin_Sketch({ subsets: ['latin'], weight: ['400', '700'], variable: '--font-sketch' })
const pencilFont = Reenie_Beanie({ subsets: ['latin'], weight: '400', variable: '--font-pencil' })
const typewriterFont = Cutive_Mono({ subsets: ['latin'], weight: '400', variable: '--font-typewriter' })

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
    <html lang="en" className={`${interfaceFont.variable} ${sketchDisplayFont.variable} ${pencilFont.variable} ${typewriterFont.variable}`}>
      <body className="antialiased">
        {children}
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}

