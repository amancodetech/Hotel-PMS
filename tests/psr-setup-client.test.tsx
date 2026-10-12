/** @jest-environment jsdom */
import { jest, beforeEach, afterEach, test, expect } from '@jest/globals';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useStructureSetup } from '../apps/web/src/property/useStructureSetup.js';
import {
  setupApi,
  type SetupDraftInputV2,
  type SetupDraft,
  type SetupPreview,
} from '../apps/web/src/api/setup.js';
import { propertyApi } from '../apps/web/src/api/property.js';
import { ApiError } from '../apps/web/src/api/client.js';

const input: SetupDraftInputV2 = {
  schema_version: 2,
  property: { name: 'Example' },
  locations: [],
  unit_groups: [],
  operations: {},
  pricing: { postponed: true },
};
const draft: SetupDraft = {
  draft_id: 'draft',
  property_id: 'property',
  revision: 1,
  completed: false,
  updated_at: '',
  updated_by_user_id: null,
  input,
};
beforeEach(() => {
  jest.spyOn(setupApi, 'getBatch').mockResolvedValue({ batch: null });
  Object.defineProperty(globalThis, 'structuredClone', {
    configurable: true,
    value: (v: unknown) => JSON.parse(JSON.stringify(v)),
  });
  jest
    .spyOn(propertyApi, 'getProperty')
    .mockResolvedValue({ property: { status: 'SETUP' } } as never);
  jest.spyOn(setupApi, 'getDraft').mockResolvedValue({ draft });
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});
async function mount() {
  const hook = renderHook(() => useStructureSetup('tenant', 'property'));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return hook;
}
test('lost save response freezes edits and retries identical input, key and revision', async () => {
  const save = jest
    .spyOn(setupApi, 'saveDraft')
    .mockRejectedValueOnce(new TypeError('network'))
    .mockResolvedValueOnce({ draft: { ...draft, revision: 2 } });
  const { result } = await mount();
  act(() => result.current.change({ ...input, property: { name: 'Edited' } }));
  act(() => result.current.save());
  await waitFor(() => expect(result.current.uncertain).toBe(true));
  act(() => result.current.change(input));
  expect(result.current.input?.property.name).toBe('Edited');
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.uncertain).toBe(false));
  expect(save.mock.calls[1]).toEqual(save.mock.calls[0]);
  expect(save.mock.calls[0]?.[3].ifMatch).toBe('"draft:1"');
  expect(result.current.dirty).toBe(false);
});
test('editing invalidates preview and prevents apply until saved and previewed again', async () => {
  jest.spyOn(setupApi, 'previewDraft').mockResolvedValue({
    preview_version: 'v1',
    blockers: [],
  } as unknown as SetupPreview);
  const apply = jest.spyOn(setupApi, 'applyDraft');
  const { result } = await mount();
  act(() => result.current.requestPreview());
  await waitFor(() => expect(result.current.preview).not.toBeNull());
  act(() => result.current.change({ ...input, property: { name: 'New' } }));
  act(() => result.current.apply());
  expect(result.current.preview).toBeNull();
  expect(apply).not.toHaveBeenCalled();
});
test('lost apply response replays the original key and locks a completed draft', async () => {
  jest.spyOn(setupApi, 'previewDraft').mockResolvedValue({
    preview_version: 'v1',
    blockers: [],
  } as unknown as SetupPreview);
  const apply = jest
    .spyOn(setupApi, 'applyDraft')
    .mockRejectedValueOnce(new TypeError('network'))
    .mockResolvedValueOnce({ result: { property_id: 'property' } } as never);
  const { result } = await mount();
  act(() => result.current.requestPreview());
  await waitFor(() => expect(result.current.preview).not.toBeNull());
  act(() => result.current.apply());
  await waitFor(() => expect(result.current.uncertain).toBe(true));
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.stored?.completed).toBe(true));
  expect(apply.mock.calls[1]).toEqual(apply.mock.calls[0]);
  act(() =>
    result.current.change({ ...input, property: { name: 'Forbidden' } }),
  );
  expect(result.current.input?.property.name).toBe('Example');
});
test('stale revision keeps edits and permits explicit reload', async () => {
  jest
    .spyOn(setupApi, 'saveDraft')
    .mockRejectedValue(new ApiError('PREVIEW_STALE', 412, {}));
  const { result } = await mount();
  act(() => result.current.change({ ...input, property: { name: 'Keep me' } }));
  act(() => result.current.save());
  await waitFor(() => expect(result.current.error).not.toBeNull());
  expect(result.current.input?.property.name).toBe('Keep me');
  expect(result.current.uncertain).toBe(false);
  act(() => result.current.reload());
  await waitFor(() =>
    expect(result.current.input?.property.name).toBe('Example'),
  );
});
test('late response from an unmounted property cannot change the new editor', async () => {
  let resolve!: (value: { draft: SetupDraft }) => void;
  jest.spyOn(setupApi, 'saveDraft').mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const first = await mount();
  act(() => first.result.current.save());
  first.unmount();
  const second = await mount();
  await act(async () => resolve({ draft: { ...draft, completed: true } }));
  expect(second.result.current.stored?.completed).toBe(false);
  expect(second.result.current.result).toBeNull();
});

test('remount recovers the exact unresolved save request in the same session only', async () => {
  localStorage.clear();
  const save = jest
    .spyOn(setupApi, 'saveDraft')
    .mockRejectedValueOnce(new TypeError('lost response'))
    .mockResolvedValueOnce({ draft: { ...draft, revision: 2 } });
  const first = renderHook(() =>
    useStructureSetup('tenant', 'property', 'session-a'),
  );
  await waitFor(() => expect(first.result.current.loading).toBe(false));
  act(() => first.result.current.save());
  await waitFor(() => expect(first.result.current.uncertain).toBe(true));
  const request = save.mock.calls[0];
  first.unmount();
  const other = renderHook(() =>
    useStructureSetup('tenant', 'property', 'session-b'),
  );
  await waitFor(() => expect(other.result.current.loading).toBe(false));
  expect(other.result.current.uncertain).toBe(false);
  other.unmount();
  const resumed = renderHook(() =>
    useStructureSetup('tenant', 'property', 'session-a'),
  );
  await waitFor(() => expect(resumed.result.current.uncertain).toBe(true));
  act(() => resumed.result.current.retry());
  await waitFor(() => expect(resumed.result.current.uncertain).toBe(false));
  expect(save.mock.calls[1]).toEqual(request);
  expect(localStorage.length).toBe(0);
});

test('completed server draft still recovers an unresolved apply using its original preview and key', async () => {
  localStorage.clear();
  jest.spyOn(setupApi, 'previewDraft').mockResolvedValue({
    preview_version: 'original-preview',
    blockers: [],
  } as unknown as SetupPreview);
  const apply = jest
    .spyOn(setupApi, 'applyDraft')
    .mockRejectedValueOnce(new TypeError('lost response'))
    .mockResolvedValueOnce({ result: { property_id: 'property' } } as never);
  const first = renderHook(() =>
    useStructureSetup('tenant', 'property', 'apply-session'),
  );
  await waitFor(() => expect(first.result.current.loading).toBe(false));
  act(() => first.result.current.requestPreview());
  await waitFor(() => expect(first.result.current.preview).not.toBeNull());
  act(() => first.result.current.apply());
  await waitFor(() => expect(first.result.current.uncertain).toBe(true));
  first.unmount();
  jest
    .mocked(setupApi.getDraft)
    .mockResolvedValue({ draft: { ...draft, completed: true } });
  const resumed = renderHook(() =>
    useStructureSetup('tenant', 'property', 'apply-session'),
  );
  await waitFor(() => expect(resumed.result.current.uncertain).toBe(true));
  expect(resumed.result.current.stored?.completed).toBe(true);
  act(() => resumed.result.current.retry());
  await waitFor(() => expect(resumed.result.current.uncertain).toBe(false));
  expect(apply.mock.calls[1]).toEqual(apply.mock.calls[0]);
  expect(localStorage.length).toBe(0);
});

test('independent addition bypasses completed setup draft, invalidates preview on edits and replays a lost apply', async () => {
  localStorage.clear();
  jest.mocked(propertyApi.getProperty).mockResolvedValue({
    property: {
      status: 'ACTIVE',
      name: 'Existing',
      timezone: 'Asia/Jakarta',
      base_currency: 'IDR',
    },
  } as never);
  jest.mocked(setupApi.getDraft).mockClear();
  jest.spyOn(setupApi, 'previewAddition').mockResolvedValue({
    preview_version: 'addition-preview',
    property_etag: '"property:property:1:2"',
    blockers: [],
  } as unknown as SetupPreview);
  const apply = jest
    .spyOn(setupApi, 'applyAddition')
    .mockRejectedValueOnce(new TypeError('network'))
    .mockResolvedValueOnce({
      result: { property_id: 'property', created_units: 1 },
    } as never);
  const hook = renderHook(() =>
    useStructureSetup('tenant', 'property', 'addition-session', true),
  );
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  expect(setupApi.getDraft).not.toHaveBeenCalled();
  act(() =>
    hook.result.current.change({
      ...hook.result.current.input!,
      unit_groups: [
        {
          group_ref: 'g',
          physical_template: 'ROOM',
          booking_mode: 'WHOLE_ONLY',
          selection_mode: 'EXACT',
          capacity: 2,
          pattern: '101-101',
        },
      ],
    }),
  );
  act(() => hook.result.current.requestPreview());
  await waitFor(() => expect(hook.result.current.preview).not.toBeNull());
  act(() =>
    hook.result.current.change({
      ...hook.result.current.input!,
      unit_groups: [],
    }),
  );
  expect(hook.result.current.preview).toBeNull();
  act(() => hook.result.current.requestPreview());
  await waitFor(() => expect(hook.result.current.preview).not.toBeNull());
  act(() => hook.result.current.apply());
  await waitFor(() => expect(hook.result.current.uncertain).toBe(true));
  hook.unmount();
  const recovered = renderHook(() =>
    useStructureSetup('tenant', 'property', 'addition-session', true),
  );
  await waitFor(() => expect(recovered.result.current.uncertain).toBe(true));
  act(() => recovered.result.current.retry());
  await waitFor(() =>
    expect(recovered.result.current.result?.created_units).toBe(1),
  );
  expect(apply.mock.calls[1]).toEqual(apply.mock.calls[0]);
  expect(recovered.result.current.dirty).toBe(false);
  expect(localStorage.length).toBe(0);
});

test('server batch resumes after a committed step loses its response and final reload shows success', async () => {
  localStorage.clear();
  const initial = {
    id: 'batch-one',
    mode: 'DRAFT',
    completed: false,
    completed_batches: 0,
    total_batches: 2,
    total_units: 19,
    created_units: 0,
    preview_version: 'first',
    blockers: [],
    result: null,
  } as const;
  const midway = {
    ...initial,
    completed_batches: 1,
    created_units: 10,
    preview_version: 'second',
  };
  const finished = {
    ...midway,
    completed: true,
    completed_batches: 2,
    created_units: 19,
    result: {
      property_id: 'property',
      created_units: 19,
      created_products: 19,
      created_compositions: 0,
      created_rate_plan: null,
      inventory_version: 3,
      applied_at: '',
      follow_up_tasks: [],
    },
  };
  jest.mocked(setupApi.getBatch).mockResolvedValue({ batch: initial as never });
  const advance = jest
    .spyOn(setupApi, 'advanceBatch')
    .mockRejectedValueOnce(new TypeError('lost reply'));
  const first = renderHook(() =>
    useStructureSetup('tenant', 'property', 'batch-session'),
  );
  await waitFor(() => expect(first.result.current.loading).toBe(false));
  act(() => first.result.current.runBatch());
  await waitFor(() => expect(first.result.current.uncertain).toBe(true));
  first.unmount();
  jest.mocked(setupApi.getBatch).mockResolvedValue({ batch: midway as never });
  advance.mockRejectedValueOnce(new TypeError('lost final reply'));
  const second = renderHook(() =>
    useStructureSetup('tenant', 'property', 'batch-session'),
  );
  await waitFor(() =>
    expect(second.result.current.batch?.completed_batches).toBe(1),
  );
  act(() => second.result.current.runBatch());
  await waitFor(() => expect(second.result.current.uncertain).toBe(true));
  expect(advance.mock.calls[1]?.[2].completed_batches).toBe(1);
  second.unmount();
  jest
    .mocked(setupApi.getBatch)
    .mockResolvedValue({ batch: finished as never });
  const final = renderHook(() =>
    useStructureSetup('tenant', 'property', 'batch-session'),
  );
  await waitFor(() =>
    expect(final.result.current.result?.created_units).toBe(19),
  );
  expect(localStorage.length).toBe(0);
});
