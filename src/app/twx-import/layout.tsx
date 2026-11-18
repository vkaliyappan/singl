/** The app shell clips overflow, so this page scrolls itself. */
export default function Layout({ children }: { children: React.ReactNode }) {
  return <div className="h-full min-h-0 flex-1 overflow-y-auto">{children}</div>
}
