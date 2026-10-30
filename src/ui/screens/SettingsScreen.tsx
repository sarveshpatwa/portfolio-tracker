import { useRef, useState, type ChangeEvent } from 'react';
import { useLiveQuery } from '../../application/useLiveQuery';
import { backupRepo } from '../../data/repositories/backupRepo';
import { S } from '../../data/db/schema';
import { backupFileName, type BackupFile } from '../../domain/sync/backup';
import { describeChanges, type MergePlan } from '../../domain/sync/merge';
import { Dialog } from '../components/Dialog';
import { describeAge } from '../../domain/pricing/prices';
import { daysBetween, todayLocal } from '../../domain/calendar/dates';

const dateTimeFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

type Notice = { tone: 'ok' | 'error'; text: string } | null;
type Pending = { file: BackupFile; plan: MergePlan; fileName: string } | null;

export function SettingsScreen() {
  const status = useLiveQuery(
    async () => {
      const [last, snap] = await Promise.all([backupRepo.lastBackupAt(), backupRepo.snapshot()]);
      return { last, portfolios: snap.portfolios.length, entries: snap.transactions.length };
    },
    [S.settings, S.portfolios, S.transactions],
  );
  const [notice, setNotice] = useState<Notice>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const canShareFiles = typeof navigator !== 'undefined' && typeof navigator.canShare === 'function';

  const exportBackup = async (mode: 'share' | 'download') => {
    setNotice(null);
    setBusy(true);
    try {
      const backup = await backupRepo.createBackup();
      const name = backupFileName();
      const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
      if (mode === 'share') {
        const file = new File([blob], name, { type: 'application/json' });
        if (!navigator.canShare?.({ files: [file] })) throw new Error('Sharing files isn’t supported here — use Download instead.');
        await navigator.share({ files: [file], title: 'Portfolio backup' });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      }
      await backupRepo.markBackedUp();
      setNotice({ tone: 'ok', text: `Backup saved as ${name}. Open it on your other device with “Restore from backup”.` });
    } catch (err) {
      // Closing the share sheet isn't an error worth showing.
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setNotice({ tone: 'error', text: err instanceof Error ? err.message : 'The backup couldn’t be created.' });
      }
    } finally {
      setBusy(false);
    }
  };

  const onFileChosen = async (e: ChangeEvent<HTMLInputElement>) => {
    const chosen = e.target.files?.[0];
    e.target.value = ''; // allow choosing the same file again
    if (!chosen) return;
    setNotice(null);
    setBusy(true);
    try {
      const file = await backupRepo.readFile(await chosen.text());
      const plan = await backupRepo.previewMerge(file);
      setPending({ file, plan, fileName: chosen.name });
    } catch (err) {
      setNotice({ tone: 'error', text: err instanceof Error ? err.message : 'The file couldn’t be read.' });
    } finally {
      setBusy(false);
    }
  };

  const applyPending = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const plan = await backupRepo.applyMerge(pending.file);
      setPending(null);
      setNotice({
        tone: 'ok',
        text: plan.noChanges ? 'Already up to date — nothing to merge.' : `Merged: ${describeChanges(plan.changes).join(' · ')}.`,
      });
    } catch (err) {
      setNotice({ tone: 'error', text: err instanceof Error ? err.message : 'The merge failed. Nothing was changed.' });
      setPending(null);
    } finally {
      setBusy(false);
    }
  };

  const last = status.status === 'ready' ? status.data.last : undefined;
  const lastText = last
    ? `${dateTimeFmt.format(new Date(last))} (${describeAge(daysBetween(todayLocal(new Date(last)), todayLocal()))})`
    : 'never';

  return (
    <div className="screen">
      <header className="screen-header">
        <h1 className="screen-title">Settings</h1>
      </header>

      <section className="card stack" aria-labelledby="backup-title">
        <h2 id="backup-title" className="section-title">
          Backup &amp; restore
        </h2>
        <p className="small">
          Your iPhone and laptop each keep their own copy. To keep them in step, back up on the device you just used and
          restore that file on the other — restoring <b>merges</b>, so changes on both sides are kept.
        </p>
        <dl className="kv">
          <dt>Last backup on this device</dt>
          <dd className={last ? '' : 'warn-text'}>{lastText}</dd>
          {status.status === 'ready' && (
            <>
              <dt>On this device</dt>
              <dd>
                {status.data.portfolios} {status.data.portfolios === 1 ? 'portfolio' : 'portfolios'} · {status.data.entries} ledger{' '}
                {status.data.entries === 1 ? 'entry' : 'entries'}
              </dd>
            </>
          )}
        </dl>

        <div className={canShareFiles ? 'button-pair' : 'stack'}>
          {canShareFiles && (
            <button className="btn btn-primary" disabled={busy} onClick={() => void exportBackup('share')}>
              Share backup…
            </button>
          )}
          <button className={`btn ${canShareFiles ? 'btn-secondary' : 'btn-primary'}`} disabled={busy} onClick={() => void exportBackup('download')}>
            Download backup
          </button>
        </div>
        <p className="muted small">
          {canShareFiles
            ? '“Share” lets you AirDrop the file, save it to Files/iCloud/OneDrive, or send it to yourself.'
            : 'The file goes to your Downloads folder. Move it to your phone via OneDrive, iCloud, email or WhatsApp to yourself.'}{' '}
          It contains your portfolio data, so only send it somewhere private.
        </p>

        <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={(e) => void onFileChosen(e)} />
        <button className="btn btn-secondary" disabled={busy} onClick={() => fileInput.current?.click()}>
          Restore from backup…
        </button>

        {notice && (
          <p className={`notice-inline ${notice.tone === 'ok' ? 'notice-ok' : 'notice-err'}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
            {notice.text}
          </p>
        )}
      </section>

      <section className="card stack" aria-labelledby="data-title">
        <h2 id="data-title" className="section-title">
          Market data
        </h2>
        <p className="muted small">The Twelve Data API key and price refresh settings arrive in the next step.</p>
      </section>

      <section className="card stack" aria-labelledby="danger-title">
        <h2 id="danger-title" className="section-title">
          Start over on this device
        </h2>
        <p className="muted small">
          Deletes every portfolio, asset and ledger entry on this device only. Your other device and your backup files aren't
          touched.
        </p>
        <button className="btn btn-danger-outline" onClick={() => setConfirmWipe(true)}>
          Delete all data on this device…
        </button>
      </section>

      <p className="muted small center">
        Version {__APP_VERSION__} · built {dateTimeFmt.format(new Date(__BUILD_DATE__))} · data stays on this device
      </p>

      <Dialog open={!!pending} title="Restore from backup" onClose={() => setPending(null)}>
        {pending && <MergePreview pending={pending} busy={busy} onCancel={() => setPending(null)} onConfirm={() => void applyPending()} />}
      </Dialog>

      <Dialog open={confirmWipe} title="Delete all data on this device?" onClose={() => setConfirmWipe(false)}>
        {confirmWipe && (
          <div className="stack">
            <p>
              Every portfolio, asset, price and ledger entry on this device will be deleted. This can't be undone, so make a
              backup first if you might need it.
            </p>
            <div className="row-end">
              <button className="btn btn-ghost" onClick={() => setConfirmWipe(false)}>
                Cancel
              </button>
              <button
                className="btn btn-danger"
                onClick={() =>
                  backupRepo.clearAllData().then(
                    () => {
                      setConfirmWipe(false);
                      setNotice({ tone: 'ok', text: 'All data on this device was deleted.' });
                    },
                    (err: unknown) => setNotice({ tone: 'error', text: err instanceof Error ? err.message : 'Delete failed.' }),
                  )
                }
              >
                Delete everything
              </button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}

function MergePreview({ pending, busy, onCancel, onConfirm }: { pending: NonNullable<Pending>; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const { plan, file, fileName } = pending;
  const lines = describeChanges(plan.changes);
  return (
    <div className="stack">
      <p className="small">
        <b>{fileName}</b>
        <br />
        made {dateTimeFmt.format(new Date(file.exportedAt))}
      </p>
      {plan.problems.length > 0 ? (
        <>
          <p className="field-error" role="alert">
            This backup can't be merged safely, so nothing will be changed:
          </p>
          <ul className="small">
            {plan.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </>
      ) : plan.noChanges ? (
        <p>This device already has everything in this backup. Nothing to merge.</p>
      ) : (
        <>
          <p>Merging will make these changes on this device:</p>
          <ul className="change-list">
            {lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <p className="muted small">Anything that exists only on this device is kept. Where both devices changed the same item, the most recent change wins.</p>
        </>
      )}
      <div className="row-end">
        <button className="btn btn-ghost" onClick={onCancel}>
          {plan.problems.length > 0 || plan.noChanges ? 'Close' : 'Cancel'}
        </button>
        {plan.problems.length === 0 && !plan.noChanges && (
          <button className="btn btn-primary" disabled={busy} onClick={onConfirm}>
            Merge
          </button>
        )}
      </div>
    </div>
  );
}
