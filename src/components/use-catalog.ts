import { useEffect, useState } from 'react'

import type { Catalog } from '#src/anatomy/catalog.ts'

// The anatomy model's catalog in the browser, for the pages that draw the body map (/body,
// /renfo): fetched once from the server's /anatomy/structures.json, absent without the model

export type CatalogState =
  | { readonly tag: 'loading' }
  | { readonly tag: 'absent' }
  | { readonly tag: 'failed'; readonly message: string }
  | { readonly tag: 'ready'; readonly catalog: Catalog }

// The catalog, once: absent when the server has no model
const loadCatalog = async (): Promise<CatalogState> => {
  try {
    const response = await fetch('/anatomy/structures.json')
    if (response.status === 404) return { tag: 'absent' }
    if (!response.ok) return { tag: 'failed', message: `HTTP ${response.status}` }
    // The server's own asset, served as it is
    return { tag: 'ready', catalog: (await response.json()) as Catalog }
  } catch (cause) {
    return { tag: 'failed', message: cause instanceof Error ? cause.message : String(cause) }
  }
}

export const useCatalog = () => {
  const [state, setState] = useState<CatalogState>({ tag: 'loading' })
  useEffect(() => {
    void loadCatalog().then(setState)
  }, [])
  return state
}
