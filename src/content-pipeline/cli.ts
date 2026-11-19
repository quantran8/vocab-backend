import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { collectionBySlug } from './collections';
import { writeLexicon } from './lexicon/build-lexicon';
import { fetchSources } from './sources';
import { load } from './stages/load';
import { report } from './stages/report';
import { checkTask, exportTasks, ingestTasks } from './stages/tasks';

// Stage order and options: docs/content-pipeline.md
const USAGE = `pnpm content <stage> [options]
  fetch      download missing sources into content/sources        [--force]
  lexicon    build content/build/lexicon.json from the sources
  tasks generate   write AI task files: meanings, levels, examples, topics  [--limit n] [--only key,key] [--force] [--retry-issues] [--fixes-only] [--batch 10]
  tasks review     write AI task files: independent check of each word     [--limit n] [--batch 10]
  tasks rank       write AI task files: order of each word's meanings      [--limit n] [--batch 30]
  tasks translate  write AI task files: translations into every app locale  [--limit n] [--batch 8]
  check <task-id>  validate one task output without storing it
  ingest           validate finished task outputs (<id>.out.json) and store them
  report     rule issues, translation coverage, topic sizes        [--verbose]
  load       write to DIRECT_URL (else DATABASE_URL)                [--publish] [--dry-run]
common: --collection <slug> (default essential-english)
Locales are APP_LOCALES: a meaning missing any of them is not loaded.`;

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      collection: { type: 'string', default: 'essential-english' },
      batch: { type: 'string' },
      limit: { type: 'string' },
      only: { type: 'string' },
      force: { type: 'boolean', default: false },
      'retry-issues': { type: 'boolean', default: false },
      'fixes-only': { type: 'boolean', default: false },
      publish: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
    },
  });
  const [stage, kind] = positionals;
  const spec = () => collectionBySlug(values.collection);
  const limit = values.limit ? Number(values.limit) : undefined;

  switch (stage) {
    case 'fetch': return fetchSources(values.force);
    case 'lexicon': return writeLexicon();
    case 'tasks':
      if (kind !== 'generate' && kind !== 'review' && kind !== 'rank' && kind !== 'translate') break;
      return exportTasks(spec(), kind, {
        batchSize: Number(values.batch ?? { generate: 10, review: 10, rank: 30, translate: 8 }[kind]), limit, force: values.force, retryIssues: values['retry-issues'], fixesOnly: values['fixes-only'],
        only: values.only?.split(',').map((k) => k.trim()),
      });
    case 'check': if (kind) return checkTask(spec(), kind); break;
    case 'ingest': return ingestTasks(spec());
    case 'report': return report(spec(), values.verbose);
    case 'load': return load(spec(), { publish: values.publish, dryRun: values['dry-run'] });
  }
  console.log(USAGE);
  process.exitCode = stage ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
