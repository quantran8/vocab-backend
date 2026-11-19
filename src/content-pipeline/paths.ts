import { join, resolve } from 'node:path';

export const CONTENT_DIR = resolve(process.env.CONTENT_DIR ?? 'content');
export const SOURCES_DIR = join(CONTENT_DIR, 'sources');
export const BUILD_DIR = join(CONTENT_DIR, 'build');
export const LEXICON_FILE = join(BUILD_DIR, 'lexicon.json');

export const collectionDir = (slug: string) => join(BUILD_DIR, slug);
