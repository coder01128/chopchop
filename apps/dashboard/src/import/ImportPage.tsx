import { useRef, useState } from 'react';
import { getSupabaseClient, useTenant } from '@chopchop/shared';
import {
  buildPlan,
  collectCategories,
  guessMapping,
  readRows,
  resolveAsNew,
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
  | { name: 'map'; table: SheetTable; mapping: Mapping }
  | {
      name: 'review';
      table: SheetTable;
      mapping: Mapping;
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

  // stock_mode lives on the tenant row. `save_product` reads it there too and
  // ignores any stock figure sent by an availability business, so this decides
  // what the screens say, never what the database does.
  const options = { trackStock: tenant.stockMode === 'counted' };

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
      setStage({ name: 'map', table, mapping: guessMapping(table.headers, tenant.attributeSchema) });
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : String(parseError));
    } finally {
      setBusy(false);
    }
  }

  async function toReview(table: SheetTable, mapping: Mapping) {
    setError(null);
    setBusy(true);
    try {
      const existing = await loadExisting(client, tenant.id);
      const rows = readRows(table, mapping);
      const plan = buildPlan(rows, existing, options);
      const decisions = collectCategories(rows, existing.categories);
      // The batch row is written now, at `pending`, so a seller who closes the
      // tab leaves a trace rather than nothing at all.
      const batchId = await openBatch(client, tenant.id, rows);
      setStage({ name: 'review', table, mapping, plan, decisions, existing, batchId });
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
          <p className={styles.blurb}>
            A price list as a spreadsheet — <code>.csv</code> or <code>.xlsx</code>. The first row is
            read as the column headings. The file is read on this device and never uploaded.
          </p>
          <p className={styles.blurb}>
            Nothing is written until you have seen every change on the review screen. An import never
            removes a product, whatever is missing from the file.
          </p>
          <label className={styles.filePicker}>
            <span className="cc-visually-hidden">Choose a spreadsheet</span>
            <input
              ref={fileInput}
              type="file"
              accept={ACCEPTED_FILE_TYPES}
              disabled={busy}
              onChange={(event) => void onFile(event.target.files?.[0])}
            />
          </label>
          {busy && <p className={styles.blurb}>Reading the file…</p>}
        </div>
      )}

      {stage.name === 'map' && (
        <MappingStep
          table={stage.table}
          mapping={stage.mapping}
          palette={tenant.attributeSchema}
          trackStock={options.trackStock}
          onChange={(mapping) => setStage({ ...stage, mapping })}
          onBack={reset}
          onContinue={() => void toReview(stage.table, stage.mapping)}
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
