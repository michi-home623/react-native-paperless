// @ts-check
const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('@expo/config-plugins');

/**
 * Expo config plugin that puts pdf.js (from the pdfjs-dist dependency) into android/app/src/main/assets/pdfjs,
 * where the PDF viewer loads it from (file:///android_asset/pdfjs/...). Being a plugin, it survives
 * expo prebuild --clean, which regenerates the android folder.
 */
const withPdfjsAssets = (config) =>
  withDangerousMod(config, [
    'android',
    async (cfg) => {
      const pkg = require.resolve('pdfjs-dist/package.json', {
        paths: [cfg.modRequest.projectRoot],
      });
      const src = path.dirname(pkg);
      const dest = path.join(
        cfg.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'assets',
        'pdfjs',
      );
      fs.mkdirSync(dest, { recursive: true });
      for (const f of ['pdf.min.js', 'pdf.worker.min.js']) {
        fs.copyFileSync(path.join(src, 'build', f), path.join(dest, f));
      }
      fs.copyFileSync(path.join(src, 'LICENSE'), path.join(dest, 'LICENSE.pdfjs'));
      return cfg;
    },
  ]);

module.exports = withPdfjsAssets;
