import tseslint from 'typescript-eslint';

const DB_CLIENT = '/^(db|tx)$/';
const LOOP = ':matches(ForStatement, ForOfStatement, ForInStatement, WhileStatement)';
const PER_ITEM = 'CallExpression[callee.property.name=/^(map|forEach|flatMap)$/]';
const noQueryInLoop = [
  {
    selector: `${LOOP} AwaitExpression MemberExpression[object.name=${DB_CLIENT}]`,
    message: 'No database call inside a loop: batch with inArray/insert().values([...]) (N+1).',
  },
  {
    selector: `${LOOP} AwaitExpression MemberExpression[object.property.name=${DB_CLIENT}]`,
    message: 'No database call inside a loop: batch with inArray/insert().values([...]) (N+1).',
  },
  {
    selector: `${PER_ITEM} MemberExpression[object.name=${DB_CLIENT}]`,
    message: 'No database call per array item: batch with inArray/insert().values([...]) (N+1).',
  },
  {
    selector: `${PER_ITEM} MemberExpression[object.property.name=${DB_CLIENT}]`,
    message: 'No database call per array item: batch with inArray/insert().values([...]) (N+1).',
  },
];

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...noQueryInLoop],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
