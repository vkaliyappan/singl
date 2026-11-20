/** Full-height module: the page header stays put and the panels below scroll on their own. */
export default function Layout({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
}
