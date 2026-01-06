import { useState, useEffect, useCallback } from 'react';
import {
  Box,
  Button,
  ContextView,
  Banner,
  Badge,
  Divider,
  Spinner,
  Accordion,
  AccordionItem,
  Icon,
  TextArea,
  TextField,
  Link,
} from '@stripe/ui-extension-sdk/ui';
import type { ExtensionContextValue } from '@stripe/ui-extension-sdk/context';
import { clipboardWriteText, fetchStripeSignature } from '@stripe/ui-extension-sdk/utils';

import BrandIcon from './brand_icon.svg';

// Backend API URL - TODO: update this later
const API_BASE_URL = 'https://sync-app-pearl.vercel.app';

// Types matching backend
type InstallStatus =
  | 'not_provisioned'
  | 'pending'
  | 'provisioning'
  | 'installing'
  | 'syncing'
  | 'ready'
  | 'error';

type InstallStep =
  | 'create_project'
  | 'create_database'
  | 'wait_database_ready'
  | 'apply_schema'
  | 'verify_connection'
  | 'start_sync'
  | 'verify_sync'
  | 'done'
  | 'unknown'
  | null;

interface DbStatusResponse {
  status: InstallStatus;
  step: InstallStep;
  error_message: string | null;
  connection_string: string | null;
  project_ref: string | null;
  created_at: string | null;
}

// Step labels for progress indicator
const STEP_LABELS: Record<NonNullable<InstallStep>, string> = {
  create_project: 'Creating project',
  create_database: 'Setting up database',
  wait_database_ready: 'Initializing database',
  apply_schema: 'Configuring schema',
  verify_connection: 'Verifying connection',
  start_sync: 'Enabling sync',
  verify_sync: 'Confirming sync',
  done: 'Complete',
  unknown: 'Processing',
};

// Ordered steps for progress calculation
const STEP_ORDER: NonNullable<InstallStep>[] = [
  'create_project',
  'create_database',
  'wait_database_ready',
  'apply_schema',
  'verify_connection',
  'start_sync',
  'verify_sync',
  'done',
];

// Parse connection string into individual parameters
function parseConnectionString(url: string) {
  try {
    const regex = /postgresql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/;
    const match = url.match(regex);
    if (!match) return null;
    return {
      user: match[1],
      password: match[2],
      host: match[3],
      port: match[4],
      database: match[5],
    };
  } catch {
    return null;
  }
}

// Mask a connection string (replace password with bullets)
function maskConnectionString(url: string): string {
  try {
    const regex = /(postgresql:\/\/[^:]+:)([^@]+)(@.*)/;
    const match = url.match(regex);
    if (!match) return url;
    const maskedPassword = '••••••••';
    return `${match[1]}${maskedPassword}${match[3]}`;
  } catch {
    return url;
  }
}

// Mask a password value
function maskPassword(password: string): string {
  void password;
  return '••••••••';
}

// Polling interval in ms
const POLL_INTERVAL = 5000;

// Timeout warning after 10 minutes
const TIMEOUT_WARNING_MS = 10 * 60 * 1000;

// Password reveal duration
const PASSWORD_REVEAL_MS = 5000;

// Confirmation phrase for disabling sync
const CONFIRM_PHRASE = 'remove sync';

const Home = ({ userContext, environment }: ExtensionContextValue) => {
  const userId = userContext?.id;
  const accountId = userContext?.account?.id;
  const livemode = environment?.mode === 'live';
  const [status, setStatus] = useState<DbStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [provisioning, setProvisioning] = useState(false);
  const [deprovisioning, setDeprovisioning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [showTimeout, setShowTimeout] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [revealPassword, setRevealPassword] = useState(false);
  const [showDisableConfirm, setShowDisableConfirm] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  // Fetch status from backend
  const fetchStatus = useCallback(async () => {
    if (!accountId || !userId) return;

    try {
      // Get Stripe signature for authenticated request
      const signature = await fetchStripeSignature();

      const response = await fetch(
        `${API_BASE_URL}/api/db/status?user_id=${userId}&account_id=${accountId}&livemode=${livemode}`,
        {
          headers: {
            'Stripe-Signature': signature,
          },
        }
      );

      if (response.status === 401) {
        const data = (await response.json().catch(() => null)) as
          | { error?: string; message?: string }
          | null;
        const serverMessage = typeof data?.message === 'string' ? data.message : null;

        if (serverMessage?.includes('No OAuth connection found')) {
          setError(
            `No OAuth connection found for ${environment?.mode ?? 'this'} mode. Switch your Stripe dashboard to the mode you installed in, or reinstall the app in ${environment?.mode ?? 'this'} mode.`
          );
        } else {
          setError(serverMessage || 'Please complete OAuth setup first');
        }
        setLoading(false);
        return;
      }

      if (!response.ok) {
        throw new Error('Failed to fetch status');
      }

      const data: DbStatusResponse = await response.json();
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [accountId, userId, livemode, environment?.mode]);

  // Initial fetch
  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Polling while in progress (paused during deprovisioning)
  useEffect(() => {
    if (!status) return;
    if (deprovisioning) return;

    const inProgress = ['pending', 'provisioning', 'installing', 'syncing'].includes(status.status);

    if (!inProgress) return;

    const interval = setInterval(fetchStatus, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [status, fetchStatus, deprovisioning]);

  // Track timeout
  useEffect(() => {
    if (!status) return;

    const inProgress = ['pending', 'provisioning', 'installing', 'syncing'].includes(status.status);

    if (inProgress && !startTime) {
      setStartTime(Date.now());
    }

    if (!inProgress) {
      setStartTime(null);
      setShowTimeout(false);
    }
  }, [status, startTime]);

  useEffect(() => {
    if (!startTime) return;

    const checkTimeout = () => {
      if (Date.now() - startTime > TIMEOUT_WARNING_MS) {
        setShowTimeout(true);
      }
    };

    const interval = setInterval(checkTimeout, 10000);
    return () => clearInterval(interval);
  }, [startTime]);

  // Handle provision button click
  const handleProvision = async () => {
    if (!accountId || !userId) return;

    setProvisioning(true);
    setError(null);
    setStartTime(Date.now());

    try {
      // Get Stripe signature for authenticated request
      const signature = await fetchStripeSignature();

      const response = await fetch(`${API_BASE_URL}/api/db/provision`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Stripe-Signature': signature,
        },
        body: JSON.stringify({ user_id: userId, account_id: accountId, livemode }),
      });

      if (response.status === 401) {
        const data = (await response.json().catch(() => null)) as
          | { error?: string; message?: string }
          | null;
        const serverMessage = typeof data?.message === 'string' ? data.message : null;

        if (serverMessage?.includes('No OAuth connection found')) {
          setError(
            `No OAuth connection found for ${environment?.mode ?? 'this'} mode. Switch your Stripe dashboard to the mode you installed in, or reinstall the app in ${environment?.mode ?? 'this'} mode.`
          );
        } else {
          setError(serverMessage || 'Please complete OAuth setup first');
        }
        return;
      }

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Failed to start provisioning');
      }

      const data: DbStatusResponse = await response.json();
      setStatus(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setProvisioning(false);
    }
  };

  // Handle deprovision
  const handleDeprovision = async () => {
    if (!accountId || !userId) return;

    setDeprovisioning(true);
    setError(null);

    try {
      // Get Stripe signature for authenticated request
      const signature = await fetchStripeSignature();

      const response = await fetch(
        `${API_BASE_URL}/api/db/provision?user_id=${userId}&account_id=${accountId}&livemode=${livemode}`,
        {
          method: 'DELETE',
          headers: {
            'Stripe-Signature': signature,
          },
        }
      );

      if (response.status === 401) {
        const data = (await response.json().catch(() => null)) as
          | { error?: string; message?: string }
          | null;
        const serverMessage = typeof data?.message === 'string' ? data.message : null;
        setError(serverMessage || 'Unauthorized');
        return;
      }

      if (response.status === 409) {
        const data = (await response.json().catch(() => null)) as
          | { error?: string; message?: string }
          | null;
        setError(data?.message || 'Another operation is in progress. Please try again.');
        return;
      }

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message || 'Failed to disable sync');
      }

      const data: DbStatusResponse = await response.json();
      setStatus(data);
      setShowDisableConfirm(false);
      setConfirmText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setDeprovisioning(false);
    }
  };

  // Copy to clipboard with field tracking
  const handleCopy = async (text: string, field: string) => {
    await clipboardWriteText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  // Copy password and reveal it temporarily
  const handleCopyPassword = async (password: string) => {
    await clipboardWriteText(password);
    setCopiedField('password');
    setRevealPassword(true);
    setTimeout(() => {
      setCopiedField(null);
      setRevealPassword(false);
    }, PASSWORD_REVEAL_MS);
  };

  // Calculate progress step number
  const getProgressInfo = () => {
    if (!status?.step || status.step === 'unknown') {
      return { current: 1, total: STEP_ORDER.length - 1, label: 'Starting...' };
    }
    const idx = STEP_ORDER.indexOf(status.step);
    const current = idx >= 0 ? idx + 1 : 1;
    const label = STEP_LABELS[status.step] || 'Processing';
    return { current, total: STEP_ORDER.length - 1, label };
  };

  // Check if confirm phrase matches (case-insensitive)
  const isConfirmValid = confirmText.toLowerCase().trim() === CONFIRM_PHRASE;

  const isInProgress =
    status && ['pending', 'provisioning', 'installing', 'syncing'].includes(status.status);
  const params = status?.connection_string ? parseConnectionString(status.connection_string) : null;

  // Loading state
  if (loading) {
    return (
      <ContextView title="Sync your Stripe data" brandColor="#635BFF" brandIcon={BrandIcon}>
        <Box css={{ stack: 'y', alignX: 'center', paddingY: 'xlarge' }}>
          <Spinner />
        </Box>
      </ContextView>
    );
  }

  return (
    <ContextView
      title="Sync your Stripe data"
      brandColor="#635BFF"
      brandIcon={BrandIcon}
    >
      <Box css={{ stack: 'y', gap: 'medium' }}>
        {/* Error banner */}
        {error && (
          <Banner
            type="critical"
            title="Something went wrong"
            description={error}
            actions={
              <Button onPress={fetchStatus} size="small">
                Retry
              </Button>
            }
          />
        )}

        {/* Timeout warning - only shown after 10 minutes */}
        {showTimeout && isInProgress && (
          <Banner
            type="caution"
            title="Taking longer than usual"
            description="Still working on it. Contact support if this continues."
          />
        )}

        {/* ============ NOT PROVISIONED STATE ============ */}
        {!error && status?.status === 'not_provisioned' && (
          <Box css={{ stack: 'y', gap: 'medium' }}>
            <Box css={{ font: 'body', color: 'primary' }}>
              Sync your Stripe data to a Postgres database. Query customers, subscriptions,
              invoices, and more with SQL.
            </Box>
            <Button onPress={handleProvision} disabled={provisioning}>
              {provisioning ? 'Starting...' : 'Enable data sync'}
            </Button>
          </Box>
        )}

        {/* ============ IN PROGRESS STATE ============ */}
        {!error && isInProgress && (
          <Box css={{ stack: 'y', gap: 'medium' }}>
            <Box css={{ font: 'body', color: 'primary' }}>
              Setting up your synced database. This usually takes 2-3 minutes.
            </Box>
            <Box
              css={{
                backgroundColor: 'container',
                padding: 'medium',
                borderRadius: 'medium',
                stack: 'y',
                gap: 'small',
              }}
            >
              <Box css={{ stack: 'x', gap: 'small', alignY: 'center' }}>
                <Spinner size="small" />
                <Box css={{ font: 'body', color: 'primary' }}>{getProgressInfo().label}</Box>
              </Box>
              <Box css={{ font: 'caption', color: 'secondary' }}>
                Step {getProgressInfo().current} of {getProgressInfo().total}
              </Box>
            </Box>
          </Box>
        )}

        {/* ============ ERROR STATE ============ */}
        {!error && status?.status === 'error' && (
          <Box css={{ stack: 'y', gap: 'medium' }}>
            <Banner
              type="critical"
              title="Setup failed"
              description={status.error_message || 'Something went wrong. Please try again.'}
              actions={
                <Button onPress={handleProvision} disabled={provisioning}>
                  {provisioning ? 'Starting...' : 'Try again'}
                </Button>
              }
            />
          </Box>
        )}

        {/* ============ READY STATE ============ */}
        {!error && status?.status === 'ready' && (
          <Box css={{ stack: 'y', gap: 'medium' }}>
            <Box css={{ stack: 'y', gap: 'xsmall'}}>
              <Box css={{ stack: 'x', gap: 'small', alignY: 'center' }}>
                <Badge type="positive">Sync on</Badge>
                <Box css={{ font: 'heading', color: 'primary' }}>Synced database ready</Box>
              </Box>
              <Box css={{ font: 'body', color: 'secondary' }}>
                Your Stripe data stays up to date automatically. Get the connection strings and environment variables here. Learn how how to connect to your Postgres database.&#32; 
                <Link external href="https://www.postgresql.org/docs/current/ecpg-sql-connect.html" type="secondary">
                <Box>Read docs&#32;</Box> </Link>
              </Box>
            </Box>

            {status.connection_string && (
              <Box css={{ stack: 'y', gap: 'medium' }}>
                <Box
                  css={{
                    backgroundColor: 'container',
                    padding: 'medium',
                    borderRadius: 'medium',
                    stack: 'y',
                    gap: 'small',
                  }}
                >
                  <Box css={{ font: 'caption', color: 'secondary' }}>Connection string</Box>
                  <TextArea
                    key={status.connection_string}
                    css={{ width: 'fill' }}
                    size="small"
                    rows={3}
                    resizeable={false}
                    readOnly
                    defaultValue={maskConnectionString(status.connection_string)}
                  />
                  <Button
                    type="secondary"
                    size="small"
                    onPress={() => handleCopy(status.connection_string!, 'connection')}
                  >
                    {copiedField === 'connection' ? (
                      <Box css={{ stack: 'x', gap: 'xsmall', alignY: 'center' }}>
                        <Icon name="check" size="xsmall" />
                        Copied
                      </Box>
                    ) : (
                      'Copy'
                    )}
                  </Button>
                </Box>

                {/* Individual parameters accordion */}
                {params && (
                  <Accordion>
                    <AccordionItem
                      title={<Box css={{ font: 'caption', color: 'primary' }}>Connection parameters</Box>}
                    >
                      <Box css={{ stack: 'y', gap: 'xxsmall', paddingRight: 'small' }}>
                        {Object.entries(params).map(([key, value]) => (
                          <Box
                            key={key}
                            css={{
                              stack: 'y',
                              gap: 'xxsmall',
                            }}
                          >
                            <Box css={{ font: 'caption', color: 'secondary' }}>{key}</Box>
                            <Box
                              css={{
                                stack: 'x',
                                gap: 'xxsmall',
                                alignY: 'center',
                                distribute: 'space-between',
                              }}
                            >
                              <Box
                                css={{
                                  fontFamily: 'monospace',
                                  font: 'caption',
                                  wordBreak: 'break-all',
                                }}
                              >
                                {key === 'password'
                                  ? revealPassword
                                    ? value
                                    : maskPassword(value)
                                  : value}
                              </Box>
                              <Button
                                type="secondary"
                                size="small"
                                onPress={() =>
                                  key === 'password'
                                    ? handleCopyPassword(value)
                                    : handleCopy(value, key)
                                }
                              >
                                {copiedField === key ? (
                                  <Box css={{ stack: 'x', gap: 'xsmall', alignY: 'center' }}>
                                    <Icon name="check" size="xsmall" />
                                    Copied
                                  </Box>
                                ) : (
                                  'Copy'
                                )}
                              </Button>
                            </Box>
                          </Box>
                        ))}
                      </Box>
                    </AccordionItem>
                  </Accordion>
                )}
              </Box>
            )}
          </Box>
        )}
        
        <Divider />

        {/* ============ DISABLE SYNC SECTION ============ */}
        {status && status.status !== 'not_provisioned' && (
          <Box css={{ stack: 'y', gap: 'medium', marginTop: 'medium' }}>
            {showDisableConfirm ? (
              <Box css={{ stack: 'y', gap: 'small' }}>
                <Box css={{ font: 'caption', color: 'secondary' }}>
                  This will permanently delete your database and stop syncing.
                </Box>
                <Box css={{ font: 'caption', color: 'secondary' }}>
                  Type <Box css={{ fontFamily: 'monospace' }}>{CONFIRM_PHRASE}</Box> to confirm.
                </Box>
                <TextField
                  placeholder={CONFIRM_PHRASE}
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  size="small"
                />
                <Box css={{ stack: 'x', gap: 'small' }}>
                  <Button
                    type="destructive"
                    size="small"
                    onPress={handleDeprovision}
                    disabled={!isConfirmValid || deprovisioning}
                  >
                    {deprovisioning ? 'Removing...' : 'Confirm'}
                  </Button>
                  <Button
                    type="secondary"
                    size="small"
                    onPress={() => {
                      setShowDisableConfirm(false);
                      setConfirmText('');
                    }}
                    disabled={deprovisioning}
                  >
                    Cancel
                  </Button>
                </Box>
              </Box>
            ) : (
              <Box css={{ stack: 'y', gap: 'medium' }}>
              <Box css={{ font: 'caption', color: 'secondary' }}>
                No longer want a synced database?
              </Box>
              <Button
                type="destructive"
                onPress={() => setShowDisableConfirm(true)}
                disabled={deprovisioning}
              >
                Disable sync
              </Button>
              </Box>
            )}
          </Box>
        )}
      </Box>
    </ContextView>
  );
};

export default Home;
