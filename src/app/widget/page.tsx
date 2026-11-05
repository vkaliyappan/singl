import type { Metadata } from "next"
import { ClockWidget } from "@/components/clock-widget"

export const metadata: Metadata = {
  title: "World Clock",
}

/** Content of the pop-out desktop widget window (no app chrome, see AppShell). */
export default function WidgetPage() {
  return <ClockWidget />
}
