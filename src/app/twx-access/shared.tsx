"use client"

import { useEffect, useState } from "react"
import { searchEntities } from "@/lib/services"

export type Env = { environment: string; twxBaseUrl: string }

/** Names matching `query` of an entity type, for a datalist; refreshed as the user types. */
export function useEntityNames(env: string, type: string, query: string): string[] {
  const [names, setNames] = useState<string[]>([])
  useEffect(() => {
    const timer = setTimeout(() => {
      searchEntities(env, type, query.trim() ? `*${query.trim()}*` : "*")
        .then((rows) => setNames(rows.slice(0, 50).map((r) => r.name)))
        .catch(() => setNames([]))
    }, 250)
    return () => clearTimeout(timer)
  }, [env, type, query])
  return names
}
