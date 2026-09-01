/**
 * DiscoverPage — the header's manual store refresh must REPORT its outcome.
 *
 * The refresh handler fires `api.refreshAppStore()` + `api.refreshRegistries()`
 * through `Promise.allSettled` (deliberate: one unreachable source must not stop
 * the other from being repaired). These tests pin that the settled results are
 * READ, not discarded (#6261 task 1):
 *
 * - a fulfilled registries call reporting `ok: false` with a populated `failed`
 *   array surfaces the failed source names in the page error banner;
 * - an outright rejected refresh POST surfaces its error message;
 * - a fully successful refresh surfaces nothing, and CLEARS a banner left by an
 *   earlier failed refresh (a repaired source must not wear a stale error).
 *
 * `i18nT` is mocked to `key {params}` so assertions pin the KEY and the
 * interpolated names, not any locale's copy (same style as useAppUpdates.test).
 * `useAppsData` is mocked to an empty, settled shelf: these tests exercise the
 * refresh wiring, not the query layer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { renderWithProviders } from '../../test/helpers'

const { refreshAppStore, refreshRegistries } = vi.hoisted(() => ({
  refreshAppStore: vi.fn(),
  refreshRegistries: vi.fn(),
}))

vi.mock('../../api/client', () => ({
  api: {
    refreshAppStore: (...a: unknown[]) => refreshAppStore(...a),
    refreshRegistries: (...a: unknown[]) => refreshRegistries(...a),
  },
}))

vi.mock('../../i18n/t', async importOriginal => {
  const orig = await importOriginal<typeof import('../../i18n/t')>()
  return {
    ...orig,
    i18nT: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  }
})

// An empty, settled data shape: no featured blocks, no shelf rows, no pending
// updates — the page renders its empty states and the header controls, which is
// all the refresh wiring needs.
vi.mock('./useAppsData', async importOriginal => {
  const orig = await importOriginal<typeof import('./useAppsData')>()
  return {
    ...orig,
    default: () => ({
      apps: [],
      appsLoading: false,
      appsError: null,
      registryError: null,
      loading: false,
      browseApps: [],
      featuredSections: [],
      categories: [],
      sources: [],
      installedApps: [],
      updatables: [],
      announceAppsChanged: vi.fn(),
    }),
  }
})

import DiscoverPage from './DiscoverPage'

/** The registries response shape (api/client.ts `refreshRegistries`). */
function registriesResult(over: Partial<{
  ok: boolean; refreshed: string[]; failed: string[]
  results: { name: string; ok: boolean }[]; apps: number; lastSyncedAt: string
}> = {}) {
  return {
    ok: true, refreshed: [], failed: [], results: [], apps: 0, lastSyncedAt: '',
    ...over,
  }
}

const REFRESH_LABEL = 'pages.appsPage.refresh_store'
const PARTIAL_FAILURE_KEY = 'components.registryManager.could_not_refresh_still_showing_last_synced'

async function clickRefresh() {
  const btn = await screen.findByRole('button', { name: REFRESH_LABEL })
  fireEvent.click(btn)
  // The handler re-enables the button in its `finally`, so a settled refresh is
  // observable as the disabled flag dropping.
  await waitFor(() => expect(btn).not.toBeDisabled())
}

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  refreshAppStore.mockResolvedValue({ ok: true })
  refreshRegistries.mockResolvedValue(registriesResult())
})

describe('DiscoverPage manual refresh outcome reporting', () => {
  it('surfaces failed registry sources when the refresh reports ok:false', async () => {
    refreshRegistries.mockResolvedValue(
      registriesResult({ ok: false, failed: ['broken-registry'] }),
    )
    renderWithProviders(<DiscoverPage />)
    await clickRefresh()
    expect(
      await screen.findByText(`${PARTIAL_FAILURE_KEY} {"names":"broken-registry"}`),
    ).toBeInTheDocument()
  })

  it('surfaces a rejected refresh POST via its error message', async () => {
    refreshRegistries.mockRejectedValue(new Error('registry backend unreachable'))
    renderWithProviders(<DiscoverPage />)
    await clickRefresh()
    expect(
      await screen.findByText('registry backend unreachable'),
    ).toBeInTheDocument()
  })

  it('keeps both sources firing: a rejected store refresh still reports, and the registries call still ran', async () => {
    refreshAppStore.mockRejectedValue(new Error('store refresh failed'))
    renderWithProviders(<DiscoverPage />)
    await clickRefresh()
    expect(await screen.findByText('store refresh failed')).toBeInTheDocument()
    expect(refreshRegistries).toHaveBeenCalledTimes(1)
  })

  it('shows no banner on a fully successful refresh, and clears one left by an earlier failure', async () => {
    refreshRegistries.mockResolvedValueOnce(
      registriesResult({ ok: false, failed: ['broken-registry'] }),
    )
    renderWithProviders(<DiscoverPage />)
    await clickRefresh()
    expect(
      await screen.findByText(`${PARTIAL_FAILURE_KEY} {"names":"broken-registry"}`),
    ).toBeInTheDocument()

    // The next refresh succeeds (the beforeEach default resumes after the
    // mockResolvedValueOnce above): the stale banner must clear.
    await clickRefresh()
    await waitFor(() =>
      expect(
        screen.queryByText(`${PARTIAL_FAILURE_KEY} {"names":"broken-registry"}`),
      ).not.toBeInTheDocument(),
    )
  })
})
