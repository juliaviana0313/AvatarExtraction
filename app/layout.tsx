import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'AvatarExtraction · Profile dashboard', description: 'Find and preview a public LinkedIn profile photo.' };
export default function RootLayout({children}: Readonly<{children:React.ReactNode}>) { return <html lang="en"><body>{children}</body></html>; }
