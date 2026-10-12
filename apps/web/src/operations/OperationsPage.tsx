import { resourceLabel } from '../property/resource-label.js';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Paper,
  Stack,
  Switch,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import { useAuth } from '../auth/AuthProvider.js';
import { EmptyBlock, LoadingBlock } from '../identity/TenantSelectPage.js';
import {
  ErrorAlert,
  ForbiddenPanel,
  PageHeader,
  useApiAction,
} from '../identity/shared.js';
import { api } from '../api/client.js';
import { propertyApi } from '../api/property.js';
import { operationsApi } from '../api/operations.js';
import type {
  DndLog,
  OpsNotification,
  OpsTask,
  ShiftHandover,
  WorkOrder,
} from '../api/operations.js';

interface MembershipOption {
  id: string;
  user_id: string;
  status: string;
}

function todayIso() {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
}

function addDaysIso(days: number) {
  const date = new Date(`${todayIso()}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function OperationsPage() {
  const { t } = useTranslation();
  const { activeTenantId, hasPermission } = useAuth();
  const { propertyId } = useParams<{ propertyId: string }>();
  const [tab, setTab] = useState(0);

  const canReadTasks = hasPermission('task.read');
  const canManageTasks = hasPermission('task.manage');
  const canComplete = hasPermission('task.complete');
  const canInspect = hasPermission('task.inspect');
  const canReadMaintenance = hasPermission('maintenance.read');
  const canManageMaintenance = hasPermission('maintenance.manage');
  const canReadProperty = hasPermission('property.read');
  const canReadMembers = hasPermission('membership.read');

  const board = useQuery({
    queryKey: ['operations-board', activeTenantId, propertyId],
    enabled: Boolean(activeTenantId && propertyId && canReadTasks),
    queryFn: () => operationsApi.getBoard(activeTenantId!, propertyId!),
  });
  const workOrders = useQuery({
    queryKey: ['operations-work-orders', activeTenantId, propertyId],
    enabled: Boolean(activeTenantId && propertyId && canReadMaintenance),
    queryFn: () => operationsApi.listWorkOrders(activeTenantId!, propertyId!),
  });
  const handovers = useQuery({
    queryKey: ['operations-handovers', activeTenantId, propertyId],
    enabled: Boolean(activeTenantId && propertyId && canReadTasks),
    queryFn: () => operationsApi.listHandovers(activeTenantId!, propertyId!),
  });
  const resources = useQuery({
    queryKey: ['operations-resources', activeTenantId, propertyId],
    enabled: Boolean(activeTenantId && propertyId && canReadProperty),
    queryFn: () => propertyApi.listResources(activeTenantId!, propertyId!),
  });
  const memberships = useQuery({
    queryKey: ['operations-memberships', activeTenantId],
    enabled: Boolean(activeTenantId && canReadMembers),
    queryFn: () =>
      api<{ memberships: MembershipOption[] }>(
        `/api/v1/tenants/${activeTenantId}/memberships`,
      ),
  });

  const action = useApiAction();
  const [feedback, setFeedback] = useState<string | null>(null);

  const runAction = async (work: () => Promise<unknown>, message: string) => {
    const result = await action.run(work);
    if (result !== null || action.error === null) setFeedback(message);
  };

  if (!canReadTasks && !canReadMaintenance) return <ForbiddenPanel />;
  if (board.isLoading || workOrders.isLoading) return <LoadingBlock />;
  if (board.error) return <ErrorAlert error={board.error} />;
  if (workOrders.error) return <ErrorAlert error={workOrders.error} />;

  const roomOptions = [
    ...(board.data?.tasks ?? [])
      .map((task) => ({
        id: task.resource_id,
        label: resourceLabel({
          code: task.resource_code ?? task.resource_id!,
          display_label: task.resource_display_label,
          location_path: task.resource_location_path,
        }),
      }))
      .filter((row): row is { id: string; label: string } => Boolean(row.id)),
    ...(resources.data?.items ?? []).map((resource) => ({
      id: resource.id,
      label: resourceLabel(resource),
    })),
  ].filter(
    (row, index, all) =>
      all.findIndex((entry) => entry.id === row.id) === index,
  );

  return (
    <div>
      <PageHeader
        title={t('operationsTitle')}
        description={t('operationsSubtitle')}
      />
      {board.data ? (
        <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: 'wrap' }}>
          <Chip
            color="default"
            label={`${t('opsBucketPending')}: ${board.data.buckets.pending}`}
          />
          <Chip
            color="info"
            label={`${t('opsBucketAssigned')}: ${board.data.buckets.assigned}`}
          />
          <Chip
            color="warning"
            label={`${t('opsBucketInProgress')}: ${board.data.buckets.in_progress}`}
          />
          <Chip
            color="secondary"
            label={`${t('opsBucketAwaitingInspection')}: ${board.data.buckets.awaiting_inspection}`}
          />
          <Chip
            color="success"
            label={`${t('opsBucketReady')}: ${board.data.buckets.ready}`}
          />
          {board.data.unread_notifications > 0 ? (
            <Chip
              color="error"
              label={`${t('opsUnread')}: ${board.data.unread_notifications}`}
            />
          ) : null}
        </Stack>
      ) : null}
      <ErrorAlert error={action.error} />
      {feedback ? <Alert severity="success">{feedback}</Alert> : null}

      <Tabs
        value={tab}
        onChange={(_event, value: number) => setTab(value)}
        variant="scrollable"
        allowScrollButtonsMobile
      >
        <Tab label={t('opsTabTasks')} />
        {canReadMaintenance ? <Tab label={t('opsTabMaintenance')} /> : null}
        <Tab label={t('opsTabDnd')} />
        <Tab label={t('opsTabHandover')} />
        <Tab label={t('opsTabNotifications')} />
      </Tabs>

      {tab === 0 ? (
        <TasksTab
          tenantId={activeTenantId!}
          propertyId={propertyId!}
          tasks={board.data?.tasks ?? []}
          membershipOptions={memberships.data?.memberships ?? []}
          canManage={canManageTasks}
          canComplete={canComplete}
          canInspect={canInspect}
          inspectionRequired={board.data?.inspection_required ?? false}
          runAction={runAction}
        />
      ) : null}
      {tab === 1 && canReadMaintenance ? (
        <MaintenanceTab
          tenantId={activeTenantId!}
          propertyId={propertyId!}
          workOrders={workOrders.data?.work_orders ?? []}
          roomOptions={roomOptions}
          membershipOptions={memberships.data?.memberships ?? []}
          canManage={canManageMaintenance}
          runAction={runAction}
        />
      ) : null}
      {tab === 2 ? (
        <DndTab
          tenantId={activeTenantId!}
          propertyId={propertyId!}
          logs={board.data?.dnd_logs ?? []}
          roomOptions={roomOptions}
          canManage={canManageTasks}
          canFollowUp={canComplete}
          runAction={runAction}
        />
      ) : null}
      {tab === 3 ? (
        <HandoverTab
          tenantId={activeTenantId!}
          propertyId={propertyId!}
          handovers={handovers.data?.handovers ?? []}
          membershipOptions={memberships.data?.memberships ?? []}
          canManage={canManageTasks}
          runAction={runAction}
        />
      ) : null}
      {tab === 4 ? (
        <NotificationsTab
          tenantId={activeTenantId!}
          propertyId={propertyId!}
          notifications={board.data?.notifications ?? []}
          runAction={runAction}
        />
      ) : null}
    </div>
  );
}

function taskStatusColor(status: string) {
  if (status === 'INSPECTED') return 'success';
  if (status === 'CLEAN') return 'secondary';
  if (status === 'IN_PROGRESS') return 'warning';
  if (status === 'ASSIGNED') return 'info';
  return 'default';
}

function TasksTab({
  tenantId,
  propertyId,
  tasks,
  membershipOptions,
  canManage,
  canComplete,
  canInspect,
  inspectionRequired,
  runAction,
}: {
  tenantId: string;
  propertyId: string;
  tasks: OpsTask[];
  membershipOptions: MembershipOption[];
  canManage: boolean;
  canComplete: boolean;
  canInspect: boolean;
  inspectionRequired: boolean;
  runAction: (work: () => Promise<unknown>, message: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [assignTask, setAssignTask] = useState<OpsTask | null>(null);
  const [membershipId, setMembershipId] = useState('');
  const [policyOpen, setPolicyOpen] = useState(false);
  const [inspectionFlag, setInspectionFlag] = useState(inspectionRequired);
  const [intervalDays, setIntervalDays] = useState('');
  const { activeTenantId } = useAuth();

  const policy = useQuery({
    queryKey: ['operations-policy', activeTenantId, propertyId],
    queryFn: () => operationsApi.getPolicy(tenantId, propertyId),
  });
  useEffect(() => {
    if (policy.data) {
      setInspectionFlag(policy.data.policy.inspection_required);
      setIntervalDays(
        policy.data.policy.long_stay_clean_interval_days === null
          ? ''
          : String(policy.data.policy.long_stay_clean_interval_days),
      );
    }
  }, [policy.data]);

  return (
    <Stack spacing={2} sx={{ mt: 2 }}>
      {canManage ? (
        <Stack direction="row" spacing={1}>
          <Button variant="outlined" onClick={() => setPolicyOpen(true)}>
            {t('opsPolicyAction')}
          </Button>
          {inspectionRequired ? (
            <Chip color="secondary" label={t('opsInspectionRequired')} />
          ) : null}
        </Stack>
      ) : null}
      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>{t('opsRoom')}</TableCell>
              <TableCell>{t('opsTaskType')}</TableCell>
              <TableCell>{t('opsStatus')}</TableCell>
              <TableCell>{t('opsDue')}</TableCell>
              <TableCell>{t('opsAssignee')}</TableCell>
              <TableCell align="right">{t('actions')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {tasks.map((task) => (
              <TableRow key={task.id} hover>
                <TableCell>
                  {task.resource_id
                    ? resourceLabel({
                        code: task.resource_code ?? task.resource_id,
                        display_label: task.resource_display_label,
                        location_path: task.resource_location_path,
                      })
                    : '—'}
                </TableCell>
                <TableCell>{t(`opsTaskTypeValue.${task.type}`)}</TableCell>
                <TableCell>
                  <Chip
                    size="small"
                    color={taskStatusColor(task.status)}
                    label={t(`opsTaskStatus.${task.status}`)}
                  />
                </TableCell>
                <TableCell>{task.due_date ?? '—'}</TableCell>
                <TableCell>
                  {task.assignee_membership_id
                    ? t('opsAssigned')
                    : t('opsUnassigned')}
                </TableCell>
                <TableCell align="right">
                  <Stack direction="row" spacing={1} justifyContent="flex-end">
                    {canManage &&
                    ['PENDING', 'ASSIGNED', 'IN_PROGRESS'].includes(
                      task.status,
                    ) ? (
                      <Button
                        size="small"
                        onClick={() => {
                          setAssignTask(task);
                          setMembershipId('');
                        }}
                      >
                        {t('opsAssignAction')}
                      </Button>
                    ) : null}
                    {canComplete && task.status === 'ASSIGNED' ? (
                      <Button
                        size="small"
                        onClick={() =>
                          void runAction(
                            () =>
                              operationsApi.startTask(
                                tenantId,
                                propertyId,
                                task.id,
                                {
                                  version: task.version,
                                },
                              ),
                            t('opsTaskStarted'),
                          )
                        }
                      >
                        {t('opsStartAction')}
                      </Button>
                    ) : null}
                    {canComplete && task.status === 'IN_PROGRESS' ? (
                      <Button
                        size="small"
                        onClick={() =>
                          void runAction(
                            () =>
                              operationsApi.completeTask(
                                tenantId,
                                propertyId,
                                task.id,
                                { version: task.version },
                              ),
                            t('opsTaskCompleted'),
                          )
                        }
                      >
                        {t('opsCompleteAction')}
                      </Button>
                    ) : null}
                    {canInspect && task.status === 'CLEAN' ? (
                      <Button
                        size="small"
                        onClick={() =>
                          void runAction(
                            () =>
                              operationsApi.inspectTask(
                                tenantId,
                                propertyId,
                                task.id,
                                { version: task.version },
                              ),
                            t('opsTaskInspected'),
                          )
                        }
                      >
                        {t('opsInspectAction')}
                      </Button>
                    ) : null}
                  </Stack>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      {tasks.length === 0 ? <EmptyBlock message={t('opsNoTasks')} /> : null}

      <Dialog open={assignTask !== null} onClose={() => setAssignTask(null)}>
        <DialogTitle>{t('opsAssignAction')}</DialogTitle>
        <DialogContent>
          <TextField
            select
            fullWidth
            margin="dense"
            label={t('opsAssignee')}
            value={membershipId}
            onChange={(event) => setMembershipId(event.target.value)}
          >
            {membershipOptions.map((membership) => (
              <MenuItem key={membership.id} value={membership.id}>
                {membership.id.slice(0, 8)}
              </MenuItem>
            ))}
          </TextField>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAssignTask(null)}>{t('cancel')}</Button>
          <Button
            variant="contained"
            disabled={!membershipId}
            onClick={() => {
              const task = assignTask;
              if (!task) return;
              void runAction(
                () =>
                  operationsApi.assignTask(tenantId, propertyId, task.id, {
                    membership_id: membershipId,
                    version: task.version,
                  }),
                t('opsTaskAssigned'),
              );
              setAssignTask(null);
            }}
          >
            {t('save')}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={policyOpen} onClose={() => setPolicyOpen(false)}>
        <DialogTitle>{t('opsPolicyAction')}</DialogTitle>
        <DialogContent>
          <FormControlLabel
            control={
              <Switch
                checked={inspectionFlag}
                onChange={(event) => setInspectionFlag(event.target.checked)}
              />
            }
            label={t('opsInspectionRequired')}
          />
          <TextField
            fullWidth
            margin="dense"
            type="number"
            label={t('opsLongStayInterval')}
            value={intervalDays}
            onChange={(event) => setIntervalDays(event.target.value)}
            helperText={t('opsLongStayIntervalHelp')}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPolicyOpen(false)}>{t('cancel')}</Button>
          <Button
            variant="contained"
            onClick={() => {
              void runAction(
                () =>
                  operationsApi.setPolicy(tenantId, propertyId, {
                    inspection_required: inspectionFlag,
                    long_stay_clean_interval_days:
                      intervalDays === '' ? null : Number(intervalDays),
                    ...(policy.data?.policy.version
                      ? { version: policy.data.policy.version }
                      : {}),
                  }),
                t('opsPolicySaved'),
              );
              setPolicyOpen(false);
            }}
          >
            {t('save')}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

function MaintenanceTab({
  tenantId,
  propertyId,
  workOrders,
  roomOptions,
  membershipOptions,
  canManage,
  runAction,
}: {
  tenantId: string;
  propertyId: string;
  workOrders: WorkOrder[];
  roomOptions: Array<{ id: string; label: string }>;
  membershipOptions: MembershipOption[];
  canManage: boolean;
  runAction: (work: () => Promise<unknown>, message: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [createOpen, setCreateOpen] = useState(false);
  const [resourceId, setResourceId] = useState('');
  const [category, setCategory] = useState('GENERAL');
  const [severity, setSeverity] = useState('MEDIUM');
  const [impact, setImpact] = useState('NONE');
  const [emergency, setEmergency] = useState(false);
  const [description, setDescription] = useState('');
  const [periodStart, setPeriodStart] = useState(addDaysIso(0));
  const [periodEnd, setPeriodEnd] = useState(addDaysIso(2));
  const [assignOrder, setAssignOrder] = useState<WorkOrder | null>(null);
  const [membershipId, setMembershipId] = useState('');
  const [resolveOrder, setResolveOrder] = useState<WorkOrder | null>(null);
  const [resolveNote, setResolveNote] = useState('');
  const [reopenOrder, setReopenOrder] = useState<WorkOrder | null>(null);
  const [reopenReason, setReopenReason] = useState('');

  return (
    <Stack spacing={2} sx={{ mt: 2 }}>
      {canManage ? (
        <Button variant="contained" onClick={() => setCreateOpen(true)}>
          {t('opsNewWorkOrder')}
        </Button>
      ) : null}
      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>{t('opsRoom')}</TableCell>
              <TableCell>{t('opsCategory')}</TableCell>
              <TableCell>{t('opsSeverity')}</TableCell>
              <TableCell>{t('opsImpact')}</TableCell>
              <TableCell>{t('opsStatus')}</TableCell>
              <TableCell align="right">{t('actions')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {workOrders.map((order) => (
              <TableRow key={order.id} hover>
                <TableCell>
                  {resourceLabel({
                    code: order.resource_code ?? order.resource_id,
                    display_label: order.resource_display_label,
                    location_path: order.resource_location_path,
                  })}
                </TableCell>
                <TableCell>
                  {t(`opsWorkOrderCategory.${order.category}`)}
                </TableCell>
                <TableCell>{t(`opsSeverityValue.${order.severity}`)}</TableCell>
                <TableCell>
                  {order.impact === 'NONE' ? '—' : order.impact}
                  {order.emergency ? (
                    <Chip
                      size="small"
                      color="error"
                      label={t('opsEmergency')}
                    />
                  ) : null}
                </TableCell>
                <TableCell>{t(`opsWorkOrderStatus.${order.status}`)}</TableCell>
                <TableCell align="right">
                  <Stack direction="row" spacing={1} justifyContent="flex-end">
                    {canManage &&
                    ['OPEN', 'TRIAGED', 'ASSIGNED', 'IN_PROGRESS'].includes(
                      order.status,
                    ) ? (
                      <Button
                        size="small"
                        onClick={() => {
                          setAssignOrder(order);
                          setMembershipId('');
                        }}
                      >
                        {t('opsAssignAction')}
                      </Button>
                    ) : null}
                    {canManage && ['OPEN', 'TRIAGED'].includes(order.status) ? (
                      <Button
                        size="small"
                        onClick={() =>
                          void runAction(async () => {
                            if (order.status === 'OPEN') {
                              const triaged =
                                (await operationsApi.transitionWorkOrder(
                                  tenantId,
                                  propertyId,
                                  order.id,
                                  {
                                    status: 'TRIAGED',
                                    version: order.version,
                                  },
                                )) as { work_order: { version: number } };
                              await operationsApi.transitionWorkOrder(
                                tenantId,
                                propertyId,
                                order.id,
                                {
                                  status: 'IN_PROGRESS',
                                  version: triaged.work_order.version,
                                },
                              );
                              return;
                            }
                            await operationsApi.transitionWorkOrder(
                              tenantId,
                              propertyId,
                              order.id,
                              {
                                status: 'IN_PROGRESS',
                                version: order.version,
                              },
                            );
                          }, t('opsWorkOrderUpdated'))
                        }
                      >
                        {t('opsStartAction')}
                      </Button>
                    ) : null}
                    {canManage && order.status === 'IN_PROGRESS' ? (
                      <Button
                        size="small"
                        onClick={() => {
                          setResolveOrder(order);
                          setResolveNote('');
                        }}
                      >
                        {t('opsResolveAction')}
                      </Button>
                    ) : null}
                    {canManage && order.status === 'RESOLVED' ? (
                      <Button
                        size="small"
                        onClick={() =>
                          void runAction(
                            () =>
                              operationsApi.transitionWorkOrder(
                                tenantId,
                                propertyId,
                                order.id,
                                { status: 'VERIFIED', version: order.version },
                              ),
                            t('opsWorkOrderUpdated'),
                          )
                        }
                      >
                        {t('opsVerifyAction')}
                      </Button>
                    ) : null}
                    {canManage && order.status === 'VERIFIED' ? (
                      <Button
                        size="small"
                        color="success"
                        onClick={() =>
                          void runAction(
                            () =>
                              operationsApi.closeWorkOrder(
                                tenantId,
                                propertyId,
                                order.id,
                                { version: order.version },
                              ),
                            t('opsWorkOrderClosed'),
                          )
                        }
                      >
                        {t('opsCloseAction')}
                      </Button>
                    ) : null}
                    {canManage && order.status === 'CLOSED' ? (
                      <Button
                        size="small"
                        onClick={() => {
                          setReopenOrder(order);
                          setReopenReason('');
                        }}
                      >
                        {t('opsReopenAction')}
                      </Button>
                    ) : null}
                  </Stack>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      {workOrders.length === 0 ? (
        <EmptyBlock message={t('opsNoWorkOrders')} />
      ) : null}

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)}>
        <DialogTitle>{t('opsNewWorkOrder')}</DialogTitle>
        <DialogContent>
          <TextField
            select
            fullWidth
            margin="dense"
            label={t('opsRoom')}
            value={resourceId}
            onChange={(event) => setResourceId(event.target.value)}
          >
            {roomOptions.map((room) => (
              <MenuItem key={room.id} value={room.id}>
                {room.label}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            fullWidth
            margin="dense"
            label={t('opsCategory')}
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            {[
              'GENERAL',
              'PLUMBING',
              'ELECTRICAL',
              'HVAC',
              'SAFETY',
              'OTHER',
            ].map((value) => (
              <MenuItem key={value} value={value}>
                {t(`opsWorkOrderCategory.${value}`)}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            fullWidth
            margin="dense"
            label={t('opsSeverity')}
            value={severity}
            onChange={(event) => setSeverity(event.target.value)}
          >
            {['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((value) => (
              <MenuItem key={value} value={value}>
                {t(`opsSeverityValue.${value}`)}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            fullWidth
            margin="dense"
            label={t('opsImpact')}
            value={impact}
            onChange={(event) => setImpact(event.target.value)}
          >
            {['NONE', 'OOS', 'OOO'].map((value) => (
              <MenuItem key={value} value={value}>
                {value}
              </MenuItem>
            ))}
          </TextField>
          {impact !== 'NONE' ? (
            <>
              <TextField
                fullWidth
                margin="dense"
                type="date"
                label={t('opsPeriodStart')}
                value={periodStart}
                onChange={(event) => setPeriodStart(event.target.value)}
              />
              <TextField
                fullWidth
                margin="dense"
                type="date"
                label={t('opsPeriodEnd')}
                value={periodEnd}
                onChange={(event) => setPeriodEnd(event.target.value)}
              />
              <FormControlLabel
                control={
                  <Switch
                    checked={emergency}
                    onChange={(event) => setEmergency(event.target.checked)}
                  />
                }
                label={t('opsEmergency')}
              />
            </>
          ) : null}
          <TextField
            fullWidth
            margin="dense"
            multiline
            minRows={2}
            label={t('opsDescription')}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)}>{t('cancel')}</Button>
          <Button
            variant="contained"
            disabled={!resourceId || description.trim() === ''}
            onClick={() => {
              void runAction(
                () =>
                  operationsApi.createWorkOrder(tenantId, propertyId, {
                    resource_id: resourceId,
                    category,
                    severity,
                    impact,
                    ...(emergency ? { emergency: true } : {}),
                    description,
                    ...(impact !== 'NONE'
                      ? {
                          period: {
                            arrival: periodStart,
                            departure: periodEnd,
                          },
                        }
                      : {}),
                  }),
                t('opsWorkOrderCreated'),
              );
              setCreateOpen(false);
            }}
          >
            {t('save')}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={assignOrder !== null} onClose={() => setAssignOrder(null)}>
        <DialogTitle>{t('opsAssignAction')}</DialogTitle>
        <DialogContent>
          <TextField
            select
            fullWidth
            margin="dense"
            label={t('opsAssignee')}
            value={membershipId}
            onChange={(event) => setMembershipId(event.target.value)}
          >
            {membershipOptions.map((membership) => (
              <MenuItem key={membership.id} value={membership.id}>
                {membership.id.slice(0, 8)}
              </MenuItem>
            ))}
          </TextField>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAssignOrder(null)}>{t('cancel')}</Button>
          <Button
            variant="contained"
            disabled={!membershipId}
            onClick={() => {
              const order = assignOrder;
              if (!order) return;
              void runAction(
                () =>
                  operationsApi.assignWorkOrder(
                    tenantId,
                    propertyId,
                    order.id,
                    { membership_id: membershipId, version: order.version },
                  ),
                t('opsWorkOrderUpdated'),
              );
              setAssignOrder(null);
            }}
          >
            {t('save')}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={resolveOrder !== null}
        onClose={() => setResolveOrder(null)}
      >
        <DialogTitle>{t('opsResolveAction')}</DialogTitle>
        <DialogContent>
          <TextField
            fullWidth
            margin="dense"
            multiline
            minRows={2}
            label={t('opsResolutionNote')}
            value={resolveNote}
            onChange={(event) => setResolveNote(event.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setResolveOrder(null)}>{t('cancel')}</Button>
          <Button
            variant="contained"
            disabled={resolveNote.trim() === ''}
            onClick={() => {
              const order = resolveOrder;
              if (!order) return;
              void runAction(
                () =>
                  operationsApi.transitionWorkOrder(
                    tenantId,
                    propertyId,
                    order.id,
                    {
                      status: 'RESOLVED',
                      version: order.version,
                      note: resolveNote,
                    },
                  ),
                t('opsWorkOrderUpdated'),
              );
              setResolveOrder(null);
            }}
          >
            {t('save')}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={reopenOrder !== null} onClose={() => setReopenOrder(null)}>
        <DialogTitle>{t('opsReopenAction')}</DialogTitle>
        <DialogContent>
          <TextField
            fullWidth
            margin="dense"
            label={t('opsReopenReason')}
            value={reopenReason}
            onChange={(event) => setReopenReason(event.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setReopenOrder(null)}>{t('cancel')}</Button>
          <Button
            variant="contained"
            disabled={reopenReason.trim() === ''}
            onClick={() => {
              const order = reopenOrder;
              if (!order) return;
              void runAction(
                () =>
                  operationsApi.reopenWorkOrder(
                    tenantId,
                    propertyId,
                    order.id,
                    { reason: reopenReason, version: order.version },
                  ),
                t('opsWorkOrderReopened'),
              );
              setReopenOrder(null);
            }}
          >
            {t('save')}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

function DndTab({
  tenantId,
  propertyId,
  logs,
  roomOptions,
  canManage,
  canFollowUp,
  runAction,
}: {
  tenantId: string;
  propertyId: string;
  logs: DndLog[];
  roomOptions: Array<{ id: string; label: string }>;
  canManage: boolean;
  canFollowUp: boolean;
  runAction: (work: () => Promise<unknown>, message: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [logOpen, setLogOpen] = useState(false);
  const [resourceId, setResourceId] = useState('');
  const [note, setNote] = useState('');
  const [followUp, setFollowUp] = useState<DndLog | null>(null);
  const [followNote, setFollowNote] = useState('');

  return (
    <Stack spacing={2} sx={{ mt: 2 }}>
      {canManage ? (
        <Button variant="contained" onClick={() => setLogOpen(true)}>
          {t('opsLogDnd')}
        </Button>
      ) : null}
      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>{t('opsRoom')}</TableCell>
              <TableCell>{t('opsStatus')}</TableCell>
              <TableCell>{t('opsNote')}</TableCell>
              <TableCell>{t('opsFollowUp')}</TableCell>
              <TableCell align="right">{t('actions')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {logs.map((log) => (
              <TableRow key={log.id} hover>
                <TableCell>
                  {roomOptions.find((room) => room.id === log.resource_id)
                    ?.label ?? log.resource_id.slice(0, 8)}
                </TableCell>
                <TableCell>{t(`opsDndState.${log.state}`)}</TableCell>
                <TableCell>{log.note}</TableCell>
                <TableCell>{log.follow_up_attempt_at ?? '—'}</TableCell>
                <TableCell align="right">
                  {canFollowUp && log.state === 'ACTIVE' ? (
                    <Button
                      size="small"
                      onClick={() => {
                        setFollowUp(log);
                        setFollowNote('');
                      }}
                    >
                      {t('opsFollowUpAction')}
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      {logs.length === 0 ? <EmptyBlock message={t('opsNoDnd')} /> : null}

      <Dialog open={logOpen} onClose={() => setLogOpen(false)}>
        <DialogTitle>{t('opsLogDnd')}</DialogTitle>
        <DialogContent>
          <TextField
            select
            fullWidth
            margin="dense"
            label={t('opsRoom')}
            value={resourceId}
            onChange={(event) => setResourceId(event.target.value)}
          >
            {roomOptions.map((room) => (
              <MenuItem key={room.id} value={room.id}>
                {room.label}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            fullWidth
            margin="dense"
            label={t('opsNote')}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setLogOpen(false)}>{t('cancel')}</Button>
          <Button
            variant="contained"
            disabled={!resourceId || note.trim() === ''}
            onClick={() => {
              void runAction(
                () =>
                  operationsApi.logDnd(tenantId, propertyId, {
                    resource_id: resourceId,
                    note,
                  }),
                t('opsDndLogged'),
              );
              setLogOpen(false);
            }}
          >
            {t('save')}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={followUp !== null} onClose={() => setFollowUp(null)}>
        <DialogTitle>{t('opsFollowUpAction')}</DialogTitle>
        <DialogContent>
          <TextField
            fullWidth
            margin="dense"
            label={t('opsNote')}
            value={followNote}
            onChange={(event) => setFollowNote(event.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setFollowUp(null)}>{t('cancel')}</Button>
          <Button
            variant="contained"
            disabled={followNote.trim() === ''}
            onClick={() => {
              const log = followUp;
              if (!log) return;
              void runAction(
                () =>
                  operationsApi.followUpDnd(tenantId, propertyId, log.id, {
                    note: followNote,
                  }),
                t('opsDndFollowed'),
              );
              setFollowUp(null);
            }}
          >
            {t('save')}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

function HandoverTab({
  tenantId,
  propertyId,
  handovers,
  membershipOptions,
  canManage,
  runAction,
}: {
  tenantId: string;
  propertyId: string;
  handovers: ShiftHandover[];
  membershipOptions: MembershipOption[];
  canManage: boolean;
  runAction: (work: () => Promise<unknown>, message: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [toMembership, setToMembership] = useState('');
  const [followUpMembership, setFollowUpMembership] = useState('');
  const [exceptions, setExceptions] = useState('');
  const [note, setNote] = useState('');

  return (
    <Stack spacing={2} sx={{ mt: 2 }}>
      {canManage ? (
        <Button variant="contained" onClick={() => setOpen(true)}>
          {t('opsNewHandover')}
        </Button>
      ) : null}
      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>{t('opsShiftDate')}</TableCell>
              <TableCell>{t('opsOpenTasks')}</TableCell>
              <TableCell>{t('opsOpenWorkOrders')}</TableCell>
              <TableCell>{t('opsActiveDnd')}</TableCell>
              <TableCell>{t('opsExceptions')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {handovers.map((handover) => (
              <TableRow key={handover.id} hover>
                <TableCell>{handover.shift_date}</TableCell>
                <TableCell>{handover.open_tasks}</TableCell>
                <TableCell>{handover.open_work_orders}</TableCell>
                <TableCell>{handover.active_dnd}</TableCell>
                <TableCell>{handover.exceptions_text ?? '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      {handovers.length === 0 ? (
        <EmptyBlock message={t('opsNoHandovers')} />
      ) : null}

      <Dialog open={open} onClose={() => setOpen(false)}>
        <DialogTitle>{t('opsNewHandover')}</DialogTitle>
        <DialogContent>
          <TextField
            select
            fullWidth
            margin="dense"
            label={t('opsHandoverTo')}
            value={toMembership}
            onChange={(event) => setToMembership(event.target.value)}
          >
            {membershipOptions.map((membership) => (
              <MenuItem key={membership.id} value={membership.id}>
                {membership.id.slice(0, 8)}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            fullWidth
            margin="dense"
            label={t('opsFollowUpOwner')}
            value={followUpMembership}
            onChange={(event) => setFollowUpMembership(event.target.value)}
          >
            {membershipOptions.map((membership) => (
              <MenuItem key={membership.id} value={membership.id}>
                {membership.id.slice(0, 8)}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            fullWidth
            margin="dense"
            multiline
            minRows={2}
            label={t('opsExceptions')}
            value={exceptions}
            onChange={(event) => setExceptions(event.target.value)}
          />
          <TextField
            fullWidth
            margin="dense"
            label={t('opsNote')}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>{t('cancel')}</Button>
          <Button
            variant="contained"
            onClick={() => {
              void runAction(
                () =>
                  operationsApi.createHandover(tenantId, propertyId, {
                    ...(toMembership ? { to_membership_id: toMembership } : {}),
                    ...(followUpMembership
                      ? { follow_up_membership_id: followUpMembership }
                      : {}),
                    ...(exceptions ? { exceptions_text: exceptions } : {}),
                    ...(note ? { note } : {}),
                  }),
                t('opsHandoverCreated'),
              );
              setOpen(false);
            }}
          >
            {t('save')}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

function NotificationsTab({
  tenantId,
  propertyId,
  notifications,
  runAction,
}: {
  tenantId: string;
  propertyId: string;
  notifications: OpsNotification[];
  runAction: (work: () => Promise<unknown>, message: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  return (
    <Stack spacing={2} sx={{ mt: 2 }}>
      {notifications.map((notification) => (
        <Paper
          key={notification.id}
          variant="outlined"
          sx={{ p: 2, opacity: notification.read_at ? 0.6 : 1 }}
        >
          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            justifyContent="space-between"
          >
            <Stack spacing={0.5}>
              <Typography variant="subtitle1">{notification.title}</Typography>
              <Typography variant="body2" color="text.secondary">
                {notification.body ?? ''}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {notification.created_at}
              </Typography>
            </Stack>
            <Stack direction="row" spacing={1} alignItems="center">
              <Chip
                size="small"
                color={
                  notification.severity === 'CRITICAL'
                    ? 'error'
                    : notification.severity === 'WARNING'
                      ? 'warning'
                      : 'info'
                }
                label={t(`opsNotificationSeverity.${notification.severity}`)}
              />
              {notification.read_at === null ? (
                <Button
                  size="small"
                  onClick={() =>
                    void runAction(
                      () =>
                        operationsApi.markNotificationRead(
                          tenantId,
                          propertyId,
                          notification.id,
                        ),
                      t('opsNotificationRead'),
                    )
                  }
                >
                  {t('opsMarkRead')}
                </Button>
              ) : (
                <Chip size="small" label={t('opsRead')} />
              )}
            </Stack>
          </Stack>
        </Paper>
      ))}
      {notifications.length === 0 ? (
        <EmptyBlock message={t('opsNoNotifications')} />
      ) : null}
    </Stack>
  );
}
