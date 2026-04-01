export default {
  '*.ts': ['gitleaks protect --staged --no-banner', './scripts/check-forbidden-files.sh'],
};
