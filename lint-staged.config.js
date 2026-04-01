export default {
  '*.ts': [
    'gitleaks protect --staged --no-banner',
    './scripts/check-forbidden-files.sh',
    'pnpm typecheck',
    'pnpm lint --max-warnings 0',
    'pnpm format:check',
  ],
};
