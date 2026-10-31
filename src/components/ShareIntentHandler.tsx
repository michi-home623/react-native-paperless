import React, { useEffect, useRef, useState } from 'react';
import { Snackbar } from 'react-native-paper';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useShareIntent, ShareIntentFile } from 'expo-share-intent';
import * as FileSystem from 'expo-file-system/legacy';

import { syncAll } from '@/services/syncService';
import { useAuthStore } from '@/store/authStore';
import { useNetworkStore, NetworkStatus } from '@/store/networkStore';
import { SHARED_DIR, useOfflineQueueStore } from '@/store/offlineQueueStore';

const toUri = (path: string) =>
  path.startsWith('file://') || path.startsWith('content://') ? path : `file://${path}`;
/** True only for copies inside the app cache - never delete a path that may be the user's original file. */
const inCache = (path: string) =>
  !!FileSystem.cacheDirectory && toUri(path).startsWith(FileSystem.cacheDirectory);
const nameOf = (f: ShareIntentFile) => f.fileName || f.path.split('/').pop() || 'document';

/** Shared files live in the app cache: copy them somewhere permanent before queueing them for later. */
const keepCopy = async (f: ShareIntentFile): Promise<string> => {
  await FileSystem.makeDirectoryAsync(SHARED_DIR, { intermediates: true }).catch(() => undefined);
  // time + random part: two files with the same name in one share must not overwrite each other
  const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const target = `${SHARED_DIR}${stamp}_${nameOf(f).replace(/[^\w.\-]+/g, '_')}`;
  await FileSystem.copyAsync({ from: toUri(f.path), to: target });
  return target;
};

/**
 * "Send to Paperless" from Android's share menu: PDFs and images shared from any app go straight into the upload queue
 * (a copy is kept in the app's storage) and are sent at once when the server is reachable - no extra tap. If the app
 * is offline, locked or closed before the upload, nothing is lost: AutoSync sends what is still waiting as soon as it
 * can.
 */
export const ShareIntentHandler: React.FC = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent({
    resetOnBackground: false,
    scheme: 'paperlessnative',
  });
  const hydrated = useOfflineQueueStore((s) => s.hydrated);
  const addItem = useOfflineQueueStore((s) => s.addItem);
  const [message, setMessage] = useState('');
  const busy = useRef(false);
  const [done, setDone] = useState(0); // bumped after each batch: a share that came in meanwhile is picked up then

  const files = (shareIntent.files ?? []).filter((f) => !!f.path);
  const latest = useRef(files);
  latest.current = files;

  useEffect(() => {
    // text/links are not documents: drop them silently
    if (hasShareIntent && files.length === 0) resetShareIntent();
  }, [hasShareIntent, files.length, resetShareIntent]);

  useEffect(() => {
    // wait for the stored queue to load first, so the new entries are added to it, not written over it
    if (!hasShareIntent || files.length === 0 || !hydrated || busy.current) return;
    busy.current = true;
    const batch = files;
    (async () => {
      try {
        const ids: string[] = [];
        let failed = 0;
        for (const f of batch) {
          try {
            const uri = await keepCopy(f);
            const id = addItem({
              type: 'document',
              data: {
                title: nameOf(f).replace(/\.[^/.]+$/, ''),
                fileUri: uri,
                fileName: nameOf(f),
                fileMimeType: f.mimeType,
              },
            });
            if (id) ids.push(id);
          } catch {
            failed++;
          }
        }
        // the queue is stored before the share's own copies go: until then they are the only reference to the files
        await useOfflineQueueStore.getState()._persist(useOfflineQueueStore.getState().items);
        for (const f of batch) {
          if (inCache(f.path))
            FileSystem.deleteAsync(toUri(f.path), { idempotent: true }).catch(() => undefined);
        }
        // reset only if no other share came in while these were copied (that one is handled next, see `done`)
        const same =
          latest.current.length === batch.length &&
          latest.current.every((f, i) => f.path === batch[i].path);
        if (same) resetShareIntent();
        if (ids.length) setMessage(t('shareIntent.sending', { count: ids.length }));
        const { isAuthenticated, token } = useAuthStore.getState();
        // syncAll runs again by itself if a sync was already under way, so one call covers these files
        if (
          ids.length &&
          isAuthenticated &&
          token &&
          useNetworkStore.getState().status === NetworkStatus.Online
        ) {
          await syncAll({ includeFailed: false }).catch(() => undefined);
        }
        const left = useOfflineQueueStore.getState().items.filter((i) => ids.includes(i.id));
        const refused = left.filter((i) => i.status === 'failed').length;
        const sent = ids.length - left.length;
        const queued = left.length - refused;
        if (sent) {
          queryClient.invalidateQueries({ queryKey: ['documents'] });
          queryClient.invalidateQueries({ queryKey: ['tasks-all'] });
        }
        const parts = [
          sent ? t('shareIntent.sent', { count: sent }) : '',
          queued ? t('shareIntent.queued', { count: queued }) : '',
          failed + refused ? t('shareIntent.failed', { count: failed + refused }) : '',
        ].filter(Boolean);
        setMessage(parts.join(' '));
      } finally {
        busy.current = false;
        setDone((n) => n + 1);
      }
    })();
  }, [hasShareIntent, files, hydrated, addItem, resetShareIntent, queryClient, t, done]);

  return (
    <Snackbar visible={!!message} onDismiss={() => setMessage('')} duration={6000}>
      {message}
    </Snackbar>
  );
};
