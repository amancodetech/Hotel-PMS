import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import {
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useMatch,
  useNavigate,
} from 'react-router';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  Drawer,
  IconButton,
  Menu,
  MenuItem,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Activity,
  CalendarDays,
  Building2,
  CheckCircle2,
  CircleX,
  Coins,
  ClipboardList,
  ConciergeBell,
  Database,
  FileBarChart,
  Globe2,
  Hotel,
  Languages,
  LogOut,
  Menu as MenuIcon,
  MoonStar,
  RefreshCw,
  Settings2,
  ShieldCheck,
  UserCog,
  UsersRound,
  Wallet,
  Workflow,
  X,
} from 'lucide-react';
import { HotelTheme } from '@hotel/ui';
import {
  createI18n,
  formatInstant,
  readPreferences,
  writePreferences,
} from '@hotel/i18n';
import type { Preferences } from '@hotel/i18n';
import type { ReadinessReport } from '@hotel/contracts';
import { PageBoundary } from './PageBoundary.js';
import { AuthProvider, useAuth } from './auth/AuthProvider.js';
import { LoginPage, CallbackPage } from './identity/AuthPages.js';
import { TenantSelectPage } from './identity/TenantSelectPage.js';
import { propertyApi } from './api/property.js';
import type { Property } from './api/property.js';

function storage() {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
const initial = readPreferences(storage());
const i18n = createI18n(initial.language);

function selectedPropertyStorageKey(tenantId: string): string {
  return `hotel:selected-property:${tenantId}`;
}

function readSelectedProperty(tenantId: string | null): string | null {
  if (!tenantId) return null;
  try {
    return storage()?.getItem(selectedPropertyStorageKey(tenantId)) ?? null;
  } catch {
    return null;
  }
}

function writeSelectedProperty(tenantId: string, propertyId: string): void {
  try {
    storage()?.setItem(selectedPropertyStorageKey(tenantId), propertyId);
  } catch {
    /* Selection remains valid for this session. */
  }
}

const propertyStatusOrder: Record<Property['status'], number> = {
  ACTIVE: 0,
  SETUP: 1,
  SUSPENDED: 2,
  ARCHIVED: 3,
};
const PreferencesPage = lazy(() => import('./PreferencesPage.js'));
const MembersPage = lazy(() =>
  import('./identity/MembersPage.js').then((module) => ({
    default: module.MembersPage,
  })),
);
const RolesPage = lazy(() =>
  import('./identity/RolesPage.js').then((module) => ({
    default: module.RolesPage,
  })),
);
const AuditPage = lazy(() =>
  import('./identity/AuditPage.js').then((module) => ({
    default: module.AuditPage,
  })),
);
const PropertiesPage = lazy(() =>
  import('./property/PropertiesPage.js').then((module) => ({
    default: module.PropertiesPage,
  })),
);
const PropertySetupPage = lazy(() =>
  import('./property/PropertySetupPage.js').then((module) => ({
    default: module.PropertySetupPage,
  })),
);
const PropertyStructureSetupPage = lazy(() =>
  import('./property/PropertyStructureSetupPage.js').then((module) => ({
    default: module.PropertyStructureSetupPage,
  })),
);
const LegacySetupEntryPage = lazy(() =>
  import('./property/LegacySetupEntryPage.js').then((module) => ({
    default: module.LegacySetupEntryPage,
  })),
);
const LegacyStructureRedirect = lazy(() =>
  import('./property/LegacySetupEntryPage.js').then((module) => ({
    default: module.LegacyStructureRedirect,
  })),
);
const RatesInventoryPage = lazy(() =>
  import('./inventory/RatesInventoryPage.js').then((module) => ({
    default: module.RatesInventoryPage,
  })),
);
const ReservationsPage = lazy(() =>
  import('./reservations/ReservationsPage.js').then((module) => ({
    default: module.ReservationsPage,
  })),
);
const FrontDeskPage = lazy(() =>
  import('./frontdesk/FrontDeskPage.js').then((module) => ({
    default: module.FrontDeskPage,
  })),
);
const FinancePage = lazy(() =>
  import('./finance/FinancePage.js').then((module) => ({
    default: module.FinancePage,
  })),
);
const OperationsPage = lazy(() =>
  import('./operations/OperationsPage.js').then((module) => ({
    default: module.OperationsPage,
  })),
);
const NightAuditPage = lazy(() =>
  import('./night-audit/NightAuditPage.js').then((module) => ({
    default: module.NightAuditPage,
  })),
);
const ReportsPage = lazy(() =>
  import('./reports/ReportsPage.js').then((module) => ({
    default: module.ReportsPage,
  })),
);
const PlatformPage = lazy(() =>
  import('./platform/PlatformPage.js').then((module) => ({
    default: module.PlatformPage,
  })),
);

async function getReadiness(
  url: string,
  signal: AbortSignal,
): Promise<ReadinessReport> {
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    cache: 'no-store',
  });
  const body = await response.json();
  const data =
    response.status === 503 && body.code === 'DEPENDENCY_UNAVAILABLE'
      ? body.details
      : body;
  if (
    (!response.ok && response.status !== 503) ||
    !['ready', 'unavailable'].includes(data?.status) ||
    typeof data.checked_at !== 'string' ||
    !Number.isFinite(Date.parse(data.checked_at)) ||
    !['database', 'redis', 'identity'].every((key) =>
      ['up', 'down'].includes(data.checks?.[key]),
    )
  )
    throw new Error('STATUS_UNAVAILABLE');
  return data;
}

function ServiceStatus({
  name,
  url,
  preferences,
  online,
}: {
  name: 'api' | 'worker';
  url: string;
  preferences: Preferences;
  online: boolean;
}) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ['readiness', name],
    queryFn: ({ signal }) => getReadiness(url, signal),
    refetchInterval: 15000,
    enabled: online,
  });
  const data = query.data;
  const current = online && !query.isError;
  const state =
    !online || query.isError
      ? 'unavailable'
      : query.isFetching
        ? 'loading'
        : (data?.status ?? 'unknown');
  return (
    <section className="service-section" aria-labelledby={`${name}-title`}>
      <div className="section-heading">
        <div className="heading-label">
          <Activity size={20} aria-hidden="true" />
          <Typography id={`${name}-title`} component="h2" variant="h2">
            {t(name)}
          </Typography>
        </div>
        <div className="service-actions">
          <Chip
            size="small"
            label={t(state)}
            color={
              state === 'ready'
                ? 'success'
                : state === 'unavailable'
                  ? 'error'
                  : 'default'
            }
            variant="outlined"
          />
          <Tooltip title={t('refresh')}>
            <span>
              <IconButton
                aria-label={`${t('refresh')} ${t(name)}`}
                onClick={() => {
                  void query.refetch();
                }}
                disabled={!online || query.isFetching}
                size="small"
              >
                <RefreshCw size={19} />
              </IconButton>
            </span>
          </Tooltip>
        </div>
      </div>
      {query.isError && online ? (
        <Alert severity="error">{t('requestError')}</Alert>
      ) : null}
      <div aria-live="polite" aria-busy={query.isFetching}>
        {(['database', 'redis', 'identity'] as const).map((key) => {
          const value = current && data ? data.checks[key] : undefined;
          const Icon =
            key === 'database'
              ? Database
              : key === 'redis'
                ? Workflow
                : ShieldCheck;
          return (
            <div className="dependency-row" key={key}>
              <span className="dependency-label">
                <Icon size={19} aria-hidden="true" />
                {t(key)}
              </span>
              <span className={`dependency-state ${value ?? ''}`}>
                {query.isFetching ? (
                  <CircularProgress size={15} aria-label={t('loading')} />
                ) : value === 'up' ? (
                  <CheckCircle2 size={16} aria-hidden="true" />
                ) : value === 'down' ? (
                  <CircleX size={16} aria-hidden="true" />
                ) : null}
                {t(query.isFetching ? 'loading' : (value ?? 'unknown'))}
              </span>
            </div>
          );
        })}
      </div>
      <p className="last-check">
        {t('checked')}:{' '}
        {data
          ? formatInstant(
              data.checked_at,
              preferences.timezone,
              preferences.language,
            )
          : t('unknown')}
      </p>
    </section>
  );
}

function LanguageMenu({
  value,
  update,
}: {
  value: Preferences;
  update: (value: Preferences) => void;
}) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const labels: Record<Preferences['language'], string> = {
    'id-ID': 'Bahasa Indonesia',
    'en-US': 'English',
    ar: 'العربية',
  };
  return (
    <>
      <Tooltip title={t('language')}>
        <IconButton
          aria-label={t('language')}
          size="small"
          aria-haspopup="menu"
          aria-expanded={anchor ? 'true' : 'false'}
          onClick={(event) => setAnchor(event.currentTarget)}
        >
          <Languages size={20} />
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
      >
        {(['id-ID', 'en-US', 'ar'] as const).map((code) => (
          <MenuItem
            key={code}
            lang={code}
            selected={value.language === code}
            onClick={() => {
              setAnchor(null);
              if (code !== value.language) update({ ...value, language: code });
            }}
          >
            {labels[code]}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}

function TenantMenu() {
  const { t } = useTranslation();
  const { session, activeTenantId, selectTenant } = useAuth();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  if (!session.authenticated) return null;
  const memberships = (session.memberships ?? []).filter(
    (membership) => membership.status === 'ACTIVE',
  );
  const current = memberships.find(
    (membership) => membership.tenant_id === activeTenantId,
  );
  if (memberships.length === 0) return null;
  return (
    <div className="tenant-menu">
      <Tooltip title={t('switchTenant')}>
        <Chip
          icon={<Building2 size={16} />}
          label={current?.tenant_name ?? t('selectTenant')}
          onClick={(event) => setAnchor(event.currentTarget)}
          variant="outlined"
          aria-haspopup="menu"
          aria-expanded={anchor ? 'true' : 'false'}
        />
      </Tooltip>
      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
      >
        {memberships.map((membership) => (
          <MenuItem
            key={membership.id}
            selected={membership.tenant_id === activeTenantId}
            onClick={() => {
              setAnchor(null);
              if (membership.tenant_id !== activeTenantId)
                void selectTenant(membership.tenant_id);
            }}
          >
            {membership.tenant_name}
          </MenuItem>
        ))}
        <MenuItem component={Link} to="/select-tenant">
          {t('manageTenants')}
        </MenuItem>
      </Menu>
    </div>
  );
}

function PropertyMenu({
  properties,
  selectedPropertyId,
  loading,
  onSelect,
}: {
  properties: Property[];
  selectedPropertyId: string | null;
  loading: boolean;
  onSelect: (propertyId: string) => void;
}) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [search, setSearch] = useState('');
  const selected = properties.find(
    (property) => property.id === selectedPropertyId,
  );
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const matching = properties
    .filter(
      (property) =>
        !normalizedSearch ||
        property.code.toLocaleLowerCase().includes(normalizedSearch) ||
        property.name.toLocaleLowerCase().includes(normalizedSearch),
    )
    .slice(0, 50);

  if (!loading && properties.length === 0) return null;
  return (
    <div className="property-menu">
      <Tooltip title={t('selectProperty')}>
        <Chip
          className="property-context"
          icon={<Hotel size={16} />}
          label={selected?.name ?? t('selectProperty')}
          variant="outlined"
          disabled={loading}
          onClick={(event) => setAnchor(event.currentTarget)}
          aria-haspopup="menu"
          aria-expanded={anchor ? 'true' : 'false'}
        />
      </Tooltip>
      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => {
          setAnchor(null);
          setSearch('');
        }}
        slotProps={{ paper: { className: 'property-selector-menu' } }}
      >
        <Box className="property-selector-search">
          <TextField
            autoFocus
            fullWidth
            size="small"
            label={t('searchProperties')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
          />
        </Box>
        {matching.length === 0 ? (
          <MenuItem disabled>{t('noMatchingProperties')}</MenuItem>
        ) : (
          matching.map((property) => (
            <MenuItem
              key={property.id}
              selected={property.id === selectedPropertyId}
              onClick={() => {
                setAnchor(null);
                setSearch('');
                onSelect(property.id);
              }}
            >
              <span className="property-selector-option">
                <strong>{property.name}</strong>
                <small>
                  {property.code} · {t(`propertyStatus.${property.status}`)}
                </small>
              </span>
            </MenuItem>
          ))
        )}
        {properties.length > matching.length && !normalizedSearch ? (
          <MenuItem disabled>
            {t('propertySearchMore', {
              count: properties.length - matching.length,
            })}
          </MenuItem>
        ) : null}
      </Menu>
    </div>
  );
}

function RequireSession({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const { loading, session, activeTenantId } = useAuth();
  const location = useLocation();
  if (loading)
    return (
      <main className="auth-page" id="main">
        <CircularProgress aria-label={t('loading')} />
      </main>
    );
  if (!session.authenticated) return <Navigate to="/login" replace />;
  const memberships = session.memberships ?? [];
  if (
    !activeTenantId &&
    memberships.length > 1 &&
    location.pathname !== '/select-tenant'
  )
    return <Navigate to="/select-tenant" replace />;
  return <>{children}</>;
}

function SidebarNavigation({
  propertyId,
  platform,
  onNavigate,
  mobile = false,
}: {
  propertyId?: string;
  platform: boolean;
  onNavigate?: () => void;
  mobile?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <nav
      aria-label={t('navigation')}
      className={`sidebar${mobile ? ' sidebar-mobile' : ''}`}
      onClick={onNavigate}
    >
      {propertyId ? (
        <div className="nav-group">
          <span className="nav-group-label">{t('dailyWork')}</span>
          <NavLink to={`/properties/${propertyId}/front-desk`}>
            <ConciergeBell size={20} aria-hidden="true" />
            {t('frontDeskNav')}
          </NavLink>
          <NavLink to={`/properties/${propertyId}/reservations`}>
            <CalendarDays size={20} aria-hidden="true" />
            {t('reservationsNav')}
          </NavLink>
          <NavLink to={`/properties/${propertyId}/rates`}>
            <Coins size={20} aria-hidden="true" />
            {t('ratesInventoryNav')}
          </NavLink>
          <NavLink to={`/properties/${propertyId}/operations`}>
            <ClipboardList size={20} aria-hidden="true" />
            {t('operationsNav')}
          </NavLink>
          <NavLink to={`/properties/${propertyId}/finance`}>
            <Wallet size={20} aria-hidden="true" />
            {t('financeNav')}
          </NavLink>
          <NavLink to={`/properties/${propertyId}/night-audit`}>
            <MoonStar size={20} aria-hidden="true" />
            {t('nightAuditNav')}
          </NavLink>
          <NavLink to={`/properties/${propertyId}/reports`}>
            <FileBarChart size={20} aria-hidden="true" />
            {t('reportsNav')}
          </NavLink>
        </div>
      ) : null}
      <div className="nav-group">
        <span className="nav-group-label">{t('administration')}</span>
        <NavLink to="/properties" end>
          <Hotel size={20} aria-hidden="true" />
          {t('propertiesTitle')}
        </NavLink>
        {propertyId ? (
          <NavLink to={`/properties/${propertyId}`} end>
            <Building2 size={20} aria-hidden="true" />
            {t('propertySetup')}
          </NavLink>
        ) : null}
        <NavLink to="/members">
          <UsersRound size={20} aria-hidden="true" />
          {t('membersTitle')}
        </NavLink>
        <NavLink to="/roles">
          <UserCog size={20} aria-hidden="true" />
          {t('rolesTitle')}
        </NavLink>
        <NavLink to="/audit">
          <ShieldCheck size={20} aria-hidden="true" />
          {t('auditTitle')}
        </NavLink>
      </div>
      <div className="nav-group nav-group-system">
        <span className="nav-group-label">{t('systemGroup')}</span>
        <NavLink to="/status">
          <Activity size={20} aria-hidden="true" />
          {t('system')}
        </NavLink>
        {platform ? (
          <NavLink to="/platform">
            <Database size={20} aria-hidden="true" />
            {t('platformNav')}
          </NavLink>
        ) : null}
        <NavLink to="/preferences">
          <Settings2 size={20} aria-hidden="true" />
          {t('preferences')}
        </NavLink>
      </div>
    </nav>
  );
}

function Shell({
  value,
  update,
  saved,
}: {
  value: Preferences;
  update: (value: Preferences) => void;
  saved: boolean | null;
}) {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const { session, signOut, mfa, platform, activeTenantId, hasPermission } =
    useAuth();
  const [online, setOnline] = useState(navigator.onLine);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  useEffect(() => {
    const set = () => setOnline(navigator.onLine);
    window.addEventListener('online', set);
    window.addEventListener('offline', set);
    return () => {
      window.removeEventListener('online', set);
      window.removeEventListener('offline', set);
    };
  }, []);
  const titles: Record<string, string> = {
    '/preferences': 'preferences',
    '/members': 'membersTitle',
    '/roles': 'rolesTitle',
    '/audit': 'auditTitle',
    '/properties': 'propertiesTitle',
    '/select-tenant': 'selectTenant',
    '/platform': 'platformTitle',
    '/status': 'system',
    '/setup-preview': 'setupWizard.title',
    '/structure-preview': 'psrPreview.title',
    '/': 'system',
  };
  const propertyMatch = useMatch('/properties/:propertyId/*');
  const ratesPage =
    propertyMatch?.params['*'] === 'rates' &&
    location.pathname.endsWith('/rates');
  const reservationsPage =
    propertyMatch?.params['*'] === 'reservations' &&
    location.pathname.endsWith('/reservations');
  const frontDeskPage =
    propertyMatch?.params['*'] === 'front-desk' &&
    location.pathname.endsWith('/front-desk');
  const financePage =
    propertyMatch?.params['*'] === 'finance' &&
    location.pathname.endsWith('/finance');
  const operationsPage =
    propertyMatch?.params['*'] === 'operations' &&
    location.pathname.endsWith('/operations');
  const nightAuditPage =
    propertyMatch?.params['*'] === 'night-audit' &&
    location.pathname.endsWith('/night-audit');
  const reportsPage =
    propertyMatch?.params['*'] === 'reports' &&
    location.pathname.endsWith('/reports');
  const pageTitle = reportsPage
    ? 'reportsTitle'
    : nightAuditPage
      ? 'nightAuditTitle'
      : operationsPage
        ? 'operationsTitle'
        : financePage
          ? 'financeTitle'
          : frontDeskPage
            ? 'frontDeskTitle'
            : reservationsPage
              ? 'reservationsTitle'
              : ratesPage
                ? 'ratesInventoryTitle'
                : (titles[location.pathname] ??
                  (location.pathname.startsWith('/properties/')
                    ? 'propertySetup'
                    : 'notFound'));
  const routePropertyId = propertyMatch?.params.propertyId ?? null;
  const [preferredPropertyId, setPreferredPropertyId] = useState<string | null>(
    () => readSelectedProperty(activeTenantId),
  );
  const properties = useQuery({
    queryKey: ['properties', activeTenantId],
    enabled: Boolean(
      session.authenticated && activeTenantId && hasPermission('property.read'),
    ),
    staleTime: 60_000,
    queryFn: () => propertyApi.listProperties(activeTenantId!),
  });
  const orderedProperties = useMemo(
    () =>
      [...(properties.data?.items ?? [])].sort(
        (left, right) =>
          propertyStatusOrder[left.status] -
            propertyStatusOrder[right.status] ||
          left.code.localeCompare(right.code),
      ),
    [properties.data],
  );
  const storedProperty = orderedProperties.find(
    (property) => property.id === preferredPropertyId,
  );
  const routeProperty = orderedProperties.find(
    (property) => property.id === routePropertyId,
  );
  const selectedPropertyId =
    routePropertyId ?? storedProperty?.id ?? orderedProperties[0]?.id ?? null;

  useEffect(() => {
    setPreferredPropertyId(readSelectedProperty(activeTenantId));
  }, [activeTenantId]);
  useEffect(() => {
    if (!activeTenantId || !selectedPropertyId) return;
    if (routePropertyId && properties.data && !routeProperty) return;
    setPreferredPropertyId(selectedPropertyId);
    writeSelectedProperty(activeTenantId, selectedPropertyId);
  }, [
    activeTenantId,
    properties.data,
    routeProperty,
    routePropertyId,
    selectedPropertyId,
  ]);

  const selectProperty = (propertyId: string) => {
    if (!activeTenantId) return;
    setPreferredPropertyId(propertyId);
    writeSelectedProperty(activeTenantId, propertyId);
    if (routePropertyId) {
      const suffix = propertyMatch?.params['*'];
      void navigate(`/properties/${propertyId}${suffix ? `/${suffix}` : ''}`);
    }
  };
  const showShellHeading =
    new Set([
      '/',
      '/status',
      '/preferences',
      '/select-tenant',
      '/platform',
    ]).has(location.pathname) || pageTitle === 'notFound';
  useEffect(() => {
    document.title = `${t(pageTitle)} | HOTEL PMS`;
  }, [pageTitle, t]);
  return (
    <>
      <a className="skip-link" href="#main">
        {t('skip')}
      </a>
      <header className="topbar">
        <div className="topbar-leading">
          <Tooltip title={t('openMenu')}>
            <IconButton
              className="mobile-menu-button"
              aria-label={t('openMenu')}
              onClick={() => setMobileNavOpen(true)}
            >
              <MenuIcon size={22} />
            </IconButton>
          </Tooltip>
          <Link className="brand" to="/">
            <span className="brand-mark">
              <Building2 size={24} aria-hidden="true" />
            </span>
            <strong>{t('brand')}</strong>
          </Link>
        </div>
        <div className="topbar-actions">
          <TenantMenu />
          <PropertyMenu
            properties={orderedProperties}
            selectedPropertyId={selectedPropertyId}
            loading={properties.isLoading}
            onSelect={selectProperty}
          />
          <span className="environment">
            <Globe2 size={16} aria-hidden="true" />
            {t('environment')}
          </span>
          <LanguageMenu value={value} update={update} />
          {session.authenticated && session.user ? (
            <span className="user-chip">
              <span className="user-email">{session.user.email}</span>
              {mfa ? (
                <Chip size="small" color="success" label={t('mfaActive')} />
              ) : null}
              <Tooltip title={t('signOut')}>
                <IconButton
                  aria-label={t('signOut')}
                  size="small"
                  onClick={() => void signOut()}
                >
                  <LogOut size={18} />
                </IconButton>
              </Tooltip>
            </span>
          ) : null}
        </div>
      </header>
      <Drawer
        anchor="left"
        open={mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
        slotProps={{ paper: { className: 'mobile-nav-paper' } }}
      >
        <div className="mobile-nav-header">
          <span>{t('navigation')}</span>
          <IconButton
            aria-label={t('closeMenu')}
            onClick={() => setMobileNavOpen(false)}
          >
            <X size={22} />
          </IconButton>
        </div>
        <SidebarNavigation
          propertyId={selectedPropertyId ?? undefined}
          platform={Boolean(platform)}
          mobile
          onNavigate={() => setMobileNavOpen(false)}
        />
      </Drawer>
      <div className="workspace">
        <SidebarNavigation
          propertyId={selectedPropertyId ?? undefined}
          platform={Boolean(platform)}
        />
        <Box component="main" id="main" tabIndex={-1} className="main-content">
          {showShellHeading ? (
            <Typography
              className="shell-page-title"
              variant="h1"
              component="h1"
            >
              {t(pageTitle)}
            </Typography>
          ) : null}
          {!online ? <Alert severity="warning">{t('offline')}</Alert> : null}
          {saved !== null && location.pathname === '/preferences' ? (
            <Alert severity={saved ? 'success' : 'warning'} role="status">
              {t(saved ? 'saved' : 'saveError')}
            </Alert>
          ) : null}
          <Suspense fallback={<CircularProgress aria-label={t('loading')} />}>
            <Routes>
              <Route
                path="/"
                element={
                  session.authenticated ? (
                    <Navigate to="/properties" replace />
                  ) : (
                    <div className="services">
                      <ServiceStatus
                        name="api"
                        url="/api/v1/system/ready"
                        preferences={value}
                        online={online}
                      />
                      <ServiceStatus
                        name="worker"
                        url="/worker-health"
                        preferences={value}
                        online={online}
                      />
                    </div>
                  )
                }
              />
              <Route
                path="/status"
                element={
                  <div className="services">
                    <ServiceStatus
                      name="api"
                      url="/api/v1/system/ready"
                      preferences={value}
                      online={online}
                    />
                    <ServiceStatus
                      name="worker"
                      url="/worker-health"
                      preferences={value}
                      online={online}
                    />
                  </div>
                }
              />
              <Route
                path="/preferences"
                element={
                  <PageBoundary
                    key={location.pathname}
                    fallback={
                      <Alert
                        severity="error"
                        action={
                          <Tooltip title={t('reload')}>
                            <IconButton
                              aria-label={t('reload')}
                              onClick={() => window.location.reload()}
                            >
                              <RefreshCw size={20} />
                            </IconButton>
                          </Tooltip>
                        }
                      >
                        {t('pageError')}
                      </Alert>
                    }
                  >
                    <PreferencesPage value={value} update={update} />
                  </PageBoundary>
                }
              />
              <Route
                path="/members"
                element={
                  <RequireSession>
                    <MembersPage />
                  </RequireSession>
                }
              />
              <Route
                path="/roles"
                element={
                  <RequireSession>
                    <RolesPage />
                  </RequireSession>
                }
              />
              <Route
                path="/audit"
                element={
                  <RequireSession>
                    <AuditPage />
                  </RequireSession>
                }
              />
              <Route
                path="/properties"
                element={
                  <RequireSession>
                    <PropertiesPage />
                  </RequireSession>
                }
              />
              <Route
                path="/structure-preview"
                element={
                  <RequireSession>
                    <LegacyStructureRedirect />
                  </RequireSession>
                }
              />
              <Route
                path="/setup-preview"
                element={
                  <RequireSession>
                    <LegacySetupEntryPage />
                  </RequireSession>
                }
              />
              <Route
                path="/properties/:propertyId/structure"
                element={
                  <RequireSession>
                    <PropertyStructureSetupPage />
                  </RequireSession>
                }
              />
              <Route
                path="/properties/:propertyId"
                element={
                  <RequireSession>
                    <PropertySetupPage />
                  </RequireSession>
                }
              />
              <Route
                path="/properties/:propertyId/rates"
                element={
                  <RequireSession>
                    <RatesInventoryPage />
                  </RequireSession>
                }
              />
              <Route
                path="/properties/:propertyId/reservations"
                element={
                  <RequireSession>
                    <ReservationsPage />
                  </RequireSession>
                }
              />
              <Route
                path="/properties/:propertyId/front-desk"
                element={
                  <RequireSession>
                    <FrontDeskPage />
                  </RequireSession>
                }
              />
              <Route
                path="/properties/:propertyId/finance"
                element={
                  <RequireSession>
                    <FinancePage />
                  </RequireSession>
                }
              />
              <Route
                path="/properties/:propertyId/operations"
                element={
                  <RequireSession>
                    <OperationsPage />
                  </RequireSession>
                }
              />
              <Route
                path="/properties/:propertyId/night-audit"
                element={
                  <RequireSession>
                    <NightAuditPage />
                  </RequireSession>
                }
              />
              <Route
                path="/properties/:propertyId/reports"
                element={
                  <RequireSession>
                    <ReportsPage />
                  </RequireSession>
                }
              />
              <Route
                path="/select-tenant"
                element={
                  <RequireSession>
                    <TenantSelectPage />
                  </RequireSession>
                }
              />
              <Route
                path="/platform"
                element={
                  <RequireSession>
                    <PlatformPage />
                  </RequireSession>
                }
              />
              <Route path="*" element={<NavLink to="/">{t('back')}</NavLink>} />
            </Routes>
          </Suspense>
        </Box>
      </div>
    </>
  );
}

function AuthenticatedRoutes({
  value,
  update,
  saved,
}: {
  value: Preferences;
  update: (value: Preferences) => void;
  saved: boolean | null;
}) {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/auth/callback" element={<CallbackPage />} />
      <Route
        path="*"
        element={<Shell value={value} update={update} saved={saved} />}
      />
    </Routes>
  );
}

export function App() {
  const [value, setValue] = useState(initial);
  const [saved, setSaved] = useState<boolean | null>(null);
  const direction = value.language === 'ar' ? 'rtl' : 'ltr';
  useEffect(() => {
    document.documentElement.lang = value.language;
    document.documentElement.dir = direction;
  }, [value.language, direction]);
  const update = (next: Preferences) => {
    setValue(next);
    setSaved(writePreferences(next, storage()));
    void i18n.changeLanguage(next.language);
  };
  return (
    <I18nextProvider i18n={i18n}>
      <HotelTheme direction={direction}>
        <AuthProvider>
          <AuthenticatedRoutes value={value} update={update} saved={saved} />
        </AuthProvider>
      </HotelTheme>
    </I18nextProvider>
  );
}
