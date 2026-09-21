import { useRef, useState } from 'react';
import { getSupabaseClient, useTenant } from '@chopchop/shared';
import {
  buildPlan,
  collectCategories,
  defaultAttributeLabels,
  guessMapping,
  readRows,
  resolveAsNew,
  type AttributeLabels,
  type CategoryDecision,
  type ExistingCatalogue,
  type ImportPlan,
  type Mapping,
  type SheetTable,
} from './import-model';
import { ACCEPTED_FILE_TYPES, MAX_ROWS, parseFile } from './parse-file';
import { closeBatch, commitPlan, loadExisting, openBatch, type CommitResult } from './import-data';
import { MappingStep } from './MappingStep';
import { ReviewStep } from './ReviewStep';
import styles from './ImportPage.module.css';

/**
 * Spreadsheet import: pick, map, review, commit.
 *
 * The screen holds the steps and no rules. Everything that decides anything —
 * what a row means, what matches what, what changes — is a pure function in
 * `import-model.ts`, which is what makes it testable without a browser.
 *
 * Parsing is local. The file never leaves the seller's machine: no upload, no
 * Edge Function, no new secret and nothing to deploy. The same file input opens
 * the Files picker on a phone, which reaches Drive, Dropbox and anything saved
 * out of a WhatsApp chat.
 */

type Stage =
  | { name: 'pick' }
  | { name: 'map'; table: SheetTable; mapping: Mapping; attributeLabels: AttributeLabels }
  | {
      name: 'review';
      table: SheetTable;
      mapping: Mapping;
      attributeLabels: AttributeLabels;
      plan: ImportPlan;
      decisions: CategoryDecision[];
      existing: ExistingCatalogue;
      batchId: string;
    }
  | { name: 'done'; result: CommitResult };

export function ImportPage() {
  const tenant = useTenant();
  const client = getSupabaseClient();
  const fileInput = useRef<HTMLInputElement>(null);

  const [stage, setStage] = useState<Stage>({ name: 'pick' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragCount = useRef(0);

  const options = { trackStock: tenant.stockMode === 'counted' };

  function onDragEnter(e: React.DragEvent) {
    e.preventDefault();
    dragCount.current += 1;
    if (dragCount.current === 1) setDragging(true);
  }

  function onDragLeave(e: React.DragEvent) {
    e.preventDefault();
    dragCount.current -= 1;
    if (dragCount.current <= 0) {
      dragCount.current = 0;
      setDragging(false);
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    dragCount.current = 0;
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) void onFile(file);
  }

  function reset() {
    setStage({ name: 'pick' });
    setError(null);
    if (fileInput.current) fileInput.current.value = '';
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const table = await parseFile(file);
      if (table.headers.length === 0) {
        throw new Error('That file has no column headings in its first row.');
      }
      if (table.rows.length > MAX_ROWS) {
        throw new Error(
          `That file has ${table.rows.length} rows. Import handles up to ${MAX_ROWS} at a time — split it and run it twice.`,
        );
      }
      const mapping = guessMapping(table.headers, tenant.attributeSchema);
      const attributeLabels = defaultAttributeLabels(mapping, table.headers, tenant.attributeSchema);
      setStage({ name: 'map', table, mapping, attributeLabels });
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : String(parseError));
    } finally {
      setBusy(false);
    }
  }

  async function toReview(table: SheetTable, mapping: Mapping, labels: AttributeLabels) {
    setError(null);
    setBusy(true);
    try {
      const existing = await loadExisting(client, tenant.id);
      const rows = readRows(table, mapping);
      const plan = buildPlan(rows, existing, options);
      const decisions = collectCategories(rows, existing.categories);
      const batchId = await openBatch(client, tenant.id, rows);
      setStage({ name: 'review', table, mapping, attributeLabels: labels, plan, decisions, existing, batchId });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setBusy(false);
    }
  }

  async function cancelReview(batchId: string) {
    setBusy(true);
    try {
      await closeBatch(client, batchId, 'discarded');
    } catch (closeError) {
      // Nothing was written to the catalogue either way; the batch row is a
      // record, not a lock. Say so rather than trapping the seller here.
      setError(closeError instanceof Error ? closeError.message : String(closeError));
    } finally {
      setBusy(false);
      reset();
    }
  }

  async function commit(stageState: Extract<Stage, { name: 'review' }>) {
    setError(null);
    setBusy(true);
    try {
      const result = await commitPlan(
        client,
        tenant.id,
        stageState.plan,
        stageState.decisions,
        stageState.existing,
        options,
        stageState.attributeLabels,
        tenant.attributeSchema,
      );
      // Applied means the batch was applied, not that every row succeeded.
      await closeBatch(client, stageState.batchId, 'applied');
      setStage({ name: 'done', result });
    } catch (commitError) {
      setError(commitError instanceof Error ? commitError.message : String(commitError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.page}>
      <header className={styles.head}>
        <div>
          <p className="cc-eyebrow">Import</p>
          <h1 className={styles.heading}>Products from a file</h1>
        </div>
      </header>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {stage.name === 'pick' && (
        <div className={styles.pick}>
          <div
            className={styles.dropZone}
            data-active={dragging || undefined}
            onDragEnter={onDragEnter}
            onDragLeave={onDragLeave}
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDrop}
            onClick={() => fileInput.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                fileInput.current?.click();
              }
            }}
          >
            <input
              ref={fileInput}
              type="file"
              accept={ACCEPTED_FILE_TYPES}
              disabled={busy}
              className={styles.hiddenInput}
              onChange={(event) => void onFile(event.target.files?.[0])}
            />
            <span className={styles.dropIcon}>&#128196;</span>
            <span className={styles.dropTitle}>
              {dragging ? 'Drop your file here' : 'Drag a spreadsheet here'}
            </span>
            <span className={styles.dropHint}>
              or click to browse — <code>.csv</code>, <code>.xlsx</code>, <code>.xls</code>
            </span>
          </div>

          <p className={styles.blurb}>
            The first row is read as column headings. The file stays on this device and is never
            uploaded. Nothing is written until you review every change.
          </p>
          {busy && <p className={styles.busyNote}>Reading the file…</p>}
        </div>
      )}

      {stage.name === 'map' && (
        <MappingStep
          table={stage.table}
          mapping={stage.mapping}
          attributeLabels={stage.attributeLabels}
          trackStock={options.trackStock}
          onChange={(mapping, attributeLabels) => setStage({ ...stage, mapping, attributeLabels })}
          onBack={reset}
          onContinue={() => void toReview(stage.table, stage.mapping, stage.attributeLabels)}
        />
      )}

      {stage.name === 'review' && (
        <ReviewStep
          plan={stage.plan}
          decisions={stage.decisions}
          categories={stage.existing.categories}
          committing={busy}
          onDecisionChange={(key, action, categoryId) =>
            setStage({
              ...stage,
              decisions: stage.decisions.map((decision) =>
                decision.key === key ? { ...decision, action, categoryId } : decision,
              ),
            })
          }
          onResolveAsNew={(key) => setStage({ ...stage, plan: resolveAsNew(stage.plan, key) })}
          onCommit={() => void commit(stage)}
          onCancel={() => void cancelReview(stage.batchId)}
        />
      )}

      {stage.name === 'done' && (
        <div className={styles.done}>
          <h2 className={styles.heading}>Imported</h2>
          <ul className={styles.summary}>
            <li>
              <strong>{stage.result.itemsWritten}</strong> product
              {stage.result.itemsWritten === 1 ? '' : 's'} written
            </li>
            <li>
              <strong>{stage.result.variantsWritten}</strong> variant
              {stage.result.variantsWritten === 1 ? '' : 's'} written
            </li>
            <li>
              <strong>{stage.result.categoriesCreated}</strong> categor
              {stage.result.categoriesCreated === 1 ? 'y' : 'ies'} created
            </li>
            {stage.result.attributesAdded > 0 && (
              <li>
                <strong>{stage.result.attributesAdded}</strong> new attribute
                {stage.result.attributesAdded === 1 ? '' : 's'} added
              </li>
            )}
          </ul>

          {stage.result.failures.length > 0 && (
            <div className={styles.failures}>
              <p className={styles.failureHead}>
                {stage.result.failures.length} product
                {stage.result.failures.length === 1 ? '' : 's'} could not be written. Everything else
                was. Fix these rows and import the same file again — what already went in comes back
                as unchanged.
              </p>
              <ul>
                {stage.result.failures.map((failure) => (
                  <li key={failure.name}>
                    <strong>{failure.name}</strong> — {failure.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className={styles.actions}>
            <button type="button" className={styles.primary} onClick={reset}>
              Import another file
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
