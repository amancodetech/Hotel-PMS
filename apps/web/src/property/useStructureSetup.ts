import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client.js';
import { propertyApi } from '../api/property.js';
import {
  setupApi,
  type SetupBatch,
  type SetupDraft,
  type SetupDraftInputV2,
  type SetupPreview,
  type SetupApplyResult,
} from '../api/setup.js';

type Operation = 'batch' | 'save' | 'preview' | 'apply' | 'addition';
type StoredRequest =
  | {
      operation: 'addition';
      input: SetupDraftInputV2;
      version: string;
      options: { idempotencyKey: string; ifMatch: string };
    }
  | {
      operation: 'save';
      input: SetupDraftInputV2;
      options: { idempotencyKey: string; ifMatch: string | null };
    }
  | {
      operation: 'apply';
      version: string;
      options: { idempotencyKey: string; ifMatch: string };
    };
interface Pending {
  request?: StoredRequest;
  operation: Operation;
  execute: () => Promise<void>;
}
export function useStructureSetup(
  tenantId: string,
  propertyId: string,
  sessionScope?: string,
  addition = false,
) {
  const storageKey = sessionScope
    ? `hotel:setup-request:v1:${sessionScope}:${tenantId}:${propertyId}${addition ? ':addition' : ''}`
    : null;
  const batchStorageKey = storageKey ? `${storageKey}:batch` : null;
  const [batch, setBatch] = useState<SetupBatch | null>(null);
  const [input, setInput] = useState<SetupDraftInputV2 | null>(null);
  const [stored, setStored] = useState<SetupDraft | null>(null);
  const [preview, setPreview] = useState<SetupPreview | null>(null);
  const [result, setResult] = useState<SetupApplyResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [legacy, setLegacy] = useState(false);
  const [status, setStatus] = useState('SETUP');
  const [uncertain, setUncertain] = useState(false);
  const pending = useRef<Pending | null>(null);
  const running = useRef(false);
  const alive = useRef(false);
  const saved = useRef('');
  const [loadVersion, setLoadVersion] = useState(0);
  useEffect(() => {
    let current = true;
    alive.current = true;
    setLoading(true);
    setError(null);
    Promise.all([
      propertyApi.getProperty(tenantId, propertyId),
      addition
        ? Promise.resolve({ draft: null })
        : setupApi.getDraft(tenantId, propertyId),
      setupApi.getBatch(
        tenantId,
        propertyId,
        batchStorageKey
          ? (localStorage.getItem(batchStorageKey) ?? undefined)
          : undefined,
      ),
    ])
      .then(([property, data, batchData]) => {
        if (!current) return;
        setBatch(batchData.batch);
        const d = data.draft;
        setStored(d);
        setStatus(property.property.status);
        if (d && !('schema_version' in d.input)) {
          setLegacy(true);
          return;
        }
        setLegacy(false);
        const value: SetupDraftInputV2 = d
          ? (d.input as SetupDraftInputV2)
          : {
              schema_version: 2,
              property: {
                name: property.property.name,
                timezone: property.property.timezone,
                base_currency: property.property.base_currency,
                types: ['ROOM'],
              },
              locations: [],
              unit_groups: [],
              operations: {
                check_in: '14:00',
                check_out: '12:00',
                inspection_required: false,
                explicit_states: true,
              },
              pricing: { postponed: true },
            };
        setInput(value);
        saved.current = JSON.stringify(value);
        setPreview(null);
        setResult(
          batchData.batch?.completed && batchData.batch.result
            ? {
                ...batchData.batch.result,
                created_rate_plan:
                  batchData.batch.result.created_rate_plan ?? null,
                follow_up_tasks: batchData.batch.result.follow_up_tasks ?? [],
              }
            : null,
        );
        if (batchData.batch?.completed && batchStorageKey)
          localStorage.removeItem(batchStorageKey);
        if (storageKey) {
          const raw = localStorage.getItem(storageKey);
          if (raw) {
            const request = JSON.parse(raw) as StoredRequest;
            if (
              !['save', 'apply', 'addition'].includes(request.operation) ||
              !request.options?.idempotencyKey
            )
              throw new Error('Invalid pending setup request');
            pending.current = restoreRequest(request);
            if (
              request.operation === 'save' ||
              request.operation === 'addition'
            )
              setInput(request.input);
            setUncertain(true);
          }
        }
      })
      .catch((e) => {
        if (current) setError(e);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
      alive.current = false;
    };
  }, [
    tenantId,
    propertyId,
    loadVersion,
    storageKey,
    batchStorageKey,
    addition,
  ]);
  const dirty = input !== null && JSON.stringify(input) !== saved.current;
  useEffect(() => {
    if (!dirty && !uncertain && !busy) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, uncertain, busy]);
  async function execute(job: Pending) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    pending.current = job;
    try {
      if (storageKey && job.request)
        localStorage.setItem(storageKey, JSON.stringify(job.request));
      await job.execute();
      if (storageKey && job.request) localStorage.removeItem(storageKey);
      if (alive.current) {
        pending.current = null;
        setUncertain(false);
      }
    } catch (e) {
      if (!alive.current) return;
      setError(e);
      const ambiguous = !(e instanceof ApiError) || e.status >= 500;
      setUncertain(ambiguous);
      if (!ambiguous) {
        if (storageKey && job.request) localStorage.removeItem(storageKey);
        pending.current = null;
        setPreview(null);
      }
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function save() {
    if (
      batch ||
      addition ||
      !input ||
      uncertain ||
      busy ||
      stored?.completed ||
      status !== 'SETUP'
    )
      return;
    const snapshot = structuredClone(input);
    const options = {
      idempotencyKey: crypto.randomUUID(),
      ifMatch: stored ? `"${stored.draft_id}:${stored.revision}"` : null,
    };
    void execute(
      restoreRequest({ operation: 'save', input: snapshot, options }),
    );
  }
  function restoreRequest(request: StoredRequest): Pending {
    return {
      operation: request.operation,
      request,
      execute: async () => {
        if (request.operation === 'save') {
          const data = await setupApi.saveDraft(
            tenantId,
            propertyId,
            request.input,
            request.options,
          );
          if (!alive.current) return;
          setStored(data.draft);
          setInput(data.draft.input as SetupDraftInputV2);
          saved.current = JSON.stringify(data.draft.input);
        } else {
          const data =
            request.operation === 'addition'
              ? await setupApi.applyAddition(
                  tenantId,
                  propertyId,
                  request.input,
                  request.version,
                  request.options,
                )
              : await setupApi.applyDraft(
                  tenantId,
                  propertyId,
                  request.version,
                  request.options,
                );
          if (!alive.current) return;
          setResult(data.result);
          if (request.operation === 'addition')
            saved.current = JSON.stringify(request.input);
          setStored((previous) =>
            previous ? { ...previous, completed: true } : previous,
          );
        }
        setPreview(null);
      },
    };
  }

  function requestPreview() {
    if (
      batch ||
      !input ||
      result ||
      uncertain ||
      busy ||
      (addition
        ? !['SETUP', 'ACTIVE'].includes(status)
        : !stored || stored.completed || status !== 'SETUP' || dirty)
    )
      return;
    void execute({
      operation: 'preview',
      execute: async () => {
        const data = addition
          ? await setupApi.previewAddition(tenantId, propertyId, input)
          : await setupApi.previewDraft(tenantId, propertyId);
        if (alive.current) setPreview(data);
      },
    });
  }
  function apply() {
    if (
      batch ||
      !input ||
      result ||
      !preview ||
      preview.blockers.length ||
      uncertain ||
      busy ||
      (addition
        ? !['SETUP', 'ACTIVE'].includes(status)
        : !stored || stored.completed || status !== 'SETUP' || dirty)
    )
      return;
    const version = preview.preview_version;
    const options = {
      idempotencyKey: crypto.randomUUID(),
      ifMatch: addition
        ? preview.property_etag!
        : `"${stored!.draft_id}:${stored!.revision}"`,
    };
    void execute(
      restoreRequest(
        addition
          ? {
              operation: 'addition',
              input: structuredClone(input),
              version,
              options,
            }
          : { operation: 'apply', version, options },
      ),
    );
  }

  async function consumeBatch(current: SetupBatch) {
    if (!alive.current) return;
    setBatch(current);
    if (batchStorageKey) localStorage.setItem(batchStorageKey, current.id);
    while (!current.completed && alive.current) {
      if (current.blockers.length) return;
      const response = await setupApi.advanceBatch(
        tenantId,
        propertyId,
        current,
      );
      if (!alive.current) return;
      current = response.batch;
      setBatch(current);
    }
    if (alive.current && current.completed && current.result) {
      setResult({
        ...current.result,
        created_rate_plan: current.result.created_rate_plan ?? null,
        follow_up_tasks: current.result.follow_up_tasks ?? [],
      });
      setStored((previous) =>
        previous && !addition ? { ...previous, completed: true } : previous,
      );
      saved.current = JSON.stringify(input);
      if (batchStorageKey) localStorage.removeItem(batchStorageKey);
      setPreview(null);
    }
  }
  function runBatch() {
    if (busy || uncertain || !input) return;
    const snapshot = structuredClone(input);
    const existing = batch;
    const version = preview?.preview_version;
    const ifMatch = addition
      ? preview?.property_etag
      : stored
        ? `"${stored.draft_id}:${stored.revision}"`
        : undefined;
    if (
      !existing &&
      (!preview?.batch_plan || !version || !ifMatch || (!addition && dirty))
    )
      return;
    void execute({
      operation: 'batch',
      execute: async () => {
        const current = existing
          ? (await setupApi.getBatch(tenantId, propertyId, existing.id)).batch!
          : (
              await setupApi.startBatch(
                tenantId,
                propertyId,
                {
                  mode: addition ? 'ADDITION' : 'DRAFT',
                  ...(addition ? { input: snapshot } : {}),
                  preview_version: version!,
                },
                { idempotencyKey: `setup-batch-${version}`, ifMatch: ifMatch! },
              )
            ).batch;
        await consumeBatch(current);
      },
    });
  }
  return {
    batch,
    runBatch,
    input,
    stored,
    preview,
    result,
    error,
    busy,
    loading,
    legacy,
    status,
    dirty,
    uncertain,
    change: (next: SetupDraftInputV2) => {
      if (batch || running.current || uncertain || stored?.completed || result)
        return;
      setInput(next);
      setPreview(null);
      setError(null);
    },
    save,
    requestPreview,
    apply,
    retry: () => {
      if (pending.current) void execute(pending.current);
    },
    reload: () => {
      if (!busy && !uncertain) setLoadVersion((v) => v + 1);
    },
  };
}
