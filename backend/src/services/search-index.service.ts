export type SearchIndexCode =
  | 'INDEX_SUCCESS'
  | 'INDEX_INVALID_INPUT'
  | 'INDEX_LIMIT_EXCEEDED'
  | 'INDEX_STORE_UNAVAILABLE';

export type SearchIndexResult =
  | { ok: true; code: 'INDEX_SUCCESS'; indexed: number }
  | { ok: false; code: Exclude<SearchIndexCode, 'INDEX_SUCCESS'>; message: string; recoverable: boolean };

export interface SearchIndexEntry {
  id: string;
  content: string;
  timestamp: Date;
}

export interface SearchIndexStore {
  indexEntry(entry: SearchIndexEntry): Promise<boolean>;
  search(query: string): Promise<SearchIndexEntry[]>;
}

import { quotaManager } from '../domain/quota-management';

export async function indexSearchEntry(
  store: SearchIndexStore,
  entry: SearchIndexEntry,
  maxContentLength: number = 10000,
  quotaSubject: { actor: string; resource?: string } = { actor: 'search-index', resource: 'default' }
): Promise<SearchIndexResult> {
  if (!entry.id || !entry.content) {
    return {
      ok: false,
      code: 'INDEX_INVALID_INPUT',
      message: 'Search entry must have id and content.',
      recoverable: false,
    };
  }

  if (entry.content.length > maxContentLength) {
    return {
      ok: false,
      code: 'INDEX_LIMIT_EXCEEDED',
      message: `Content exceeds maximum length of ${maxContentLength} characters.`,
      recoverable: false,
    };
  }
  const quota = quotaManager.reserve('search_index', quotaSubject);
  if (!quota.allowed) {
    return {
      ok: false,
      code: 'INDEX_LIMIT_EXCEEDED',
      message: quota.message,
      recoverable: true,
    };
  }

  try {
    const indexed = await store.indexEntry(entry);
    if (!indexed) {
      return {
        ok: false,
        code: 'INDEX_STORE_UNAVAILABLE',
        message: 'Failed to index entry; storage returned false.',
        recoverable: true,
      };
    }

    return { ok: true, code: 'INDEX_SUCCESS', indexed: 1 };
  } catch {
    return {
      ok: false,
      code: 'INDEX_STORE_UNAVAILABLE',
      message: 'Search index store is unavailable; retry later.',
      recoverable: true,
    };
  }
}

export async function searchIndexEntries(
  store: SearchIndexStore,
  query: string
): Promise<{ ok: boolean; entries?: SearchIndexEntry[]; error?: string }> {
  if (!query || query.trim().length === 0) {
    return {
      ok: false,
      error: 'SEARCH_QUERY_EMPTY',
    };
  }

  try {
    const entries = await store.search(query);
    return { ok: true, entries };
  } catch {
    return {
      ok: false,
      error: 'SEARCH_STORE_UNAVAILABLE',
    };
  }
}
