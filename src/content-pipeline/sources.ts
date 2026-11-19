import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SOURCES_DIR } from './paths';

export interface SourceSpec {
  id: string;
  file: string;
  url: string;
  license: string;
  attribution: string;
  /** Extracted into SOURCES_DIR/<id>/ after download. */
  unzip?: boolean;
  /** Members of a .tar.gz to extract into SOURCES_DIR/<id>/. */
  untar?: string[];
}

// License review and why each source was picked: docs/content-sources.md §1.
export const SOURCES: SourceSpec[] = [
  {
    id: 'cefrj',
    file: 'cefrj-vocabulary-profile-1.5.csv',
    url: 'https://raw.githubusercontent.com/openlanguageprofiles/olp-en-cefrj/master/cefrj-vocabulary-profile-1.5.csv',
    license: 'Free for research and commercial use with citation',
    attribution: 'CEFR-J Wordlist Version 1.5. Compiled by Yukio Tono, Tokyo University of Foreign Studies.',
  },
  {
    id: 'ovp',
    file: 'octanove-vocabulary-profile-c1c2-1.0.csv',
    url: 'https://raw.githubusercontent.com/openlanguageprofiles/olp-en-cefrj/master/octanove-vocabulary-profile-c1c2-1.0.csv',
    license: 'CC BY-SA 4.0',
    attribution: 'Octanove Vocabulary Profile C1/C2 ver 1.0, Octanove Labs.',
  },
  {
    id: 'ngsl-stats',
    file: 'NGSL_12_stats.csv',
    url: 'https://www.newgeneralservicelist.com/s/NGSL_12_stats.csv',
    license: 'CC BY-SA 4.0',
    attribution: 'New General Service List 1.2 by Browne, C., Culligan, B., and Phillips, J.',
  },
  {
    id: 'ngsl-forms',
    file: 'NGSL_12_lemmatized_for_teaching.csv',
    url: 'https://www.newgeneralservicelist.com/s/NGSL_12_lemmatized_for_teaching.csv',
    license: 'CC BY-SA 4.0',
    attribution: 'New General Service List 1.2 by Browne, C., Culligan, B., and Phillips, J.',
  },
  {
    id: 'oewn',
    file: 'english-wordnet-2025-json.zip',
    url: 'https://github.com/globalwordnet/english-wordnet/releases/download/2025-edition/english-wordnet-2025-json.zip',
    license: 'CC BY 4.0',
    attribution: 'Open English WordNet 2025 Edition, Global WordNet Association.',
    unzip: true,
  },
  {
    id: 'oewn-index',
    file: 'english-wordnet-2025-index.sense-fixed.zip',
    url: 'https://github.com/globalwordnet/english-wordnet/releases/download/2025-edition/english-wordnet-2025-index.sense-fixed.zip',
    license: 'CC BY 4.0',
    attribution: 'Open English WordNet 2025 Edition, Global WordNet Association.',
    unzip: true,
  },
  {
    id: 'pwn',
    file: 'WNdb-3.0.tar.gz',
    url: 'https://wordnetcode.princeton.edu/3.0/WNdb-3.0.tar.gz',
    license: 'WordNet 3.0 license (BSD-style)',
    attribution: 'WordNet 3.0 Copyright 2006 by Princeton University. All rights reserved.',
    untar: ['dict/index.sense'],
  },
  {
    id: 'cmudict',
    file: 'cmudict.dict',
    url: 'https://raw.githubusercontent.com/cmusphinx/cmudict/master/cmudict.dict',
    license: 'BSD-2-Clause',
    attribution: 'The CMU Pronouncing Dictionary, Carnegie Mellon University.',
  },
  {
    id: 'britfone',
    file: 'britfone.main.3.0.1.csv',
    url: 'https://raw.githubusercontent.com/JoseLlarena/Britfone/master/britfone.main.3.0.1.csv',
    license: 'MIT',
    attribution: 'Britfone 3.0.1 by Jose Llarena.',
  },
];

export const sourcePath = (id: string) => join(SOURCES_DIR, SOURCES.find((s) => s.id === id)!.file);
export const extractedDir = (id: string) => join(SOURCES_DIR, id);

/** Downloads only what is missing, so re-runs reuse the local copy; `force` re-downloads. */
export async function fetchSources(force = false) {
  mkdirSync(SOURCES_DIR, { recursive: true });
  const manifest = [];
  for (const source of SOURCES) {
    const path = join(SOURCES_DIR, source.file);
    if (force || !existsSync(path)) {
      console.log(`download ${source.id} ← ${source.url}`);
      const response = await fetch(source.url);
      if (!response.ok) throw new Error(`${source.id}: HTTP ${response.status}`);
      writeFileSync(path, Buffer.from(await response.arrayBuffer()));
    }
    if (source.unzip && (force || !existsSync(extractedDir(source.id)))) {
      execFileSync('unzip', ['-oq', '-j', path, '-d', extractedDir(source.id)]);
    }
    if (source.untar && (force || !existsSync(extractedDir(source.id)))) {
      mkdirSync(extractedDir(source.id), { recursive: true });
      execFileSync('tar', ['-xzf', path, '-C', extractedDir(source.id), ...source.untar]);
    }
    const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
    manifest.push({ ...source, sha256 });
  }
  writeFileSync(join(SOURCES_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`sources ready in ${SOURCES_DIR}`);
}
