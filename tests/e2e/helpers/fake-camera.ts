/**
 * Fejkad kamera för scanner-e2e (docs/plan.md 7.8, 7.15): `getUserMedia` ersätts av en
 * ström från en canvas som ritar en riktig QR-kod. Scannerns RIKTIGA avkodning (zxing) läser
 * alltså bilden; ingen testkrok finns i produktionskoden. Ritas om med jämna mellanrum,
 * annars producerar `captureStream` inga nya bildrutor.
 */
import type { Page } from '@playwright/test';
// CommonJS-paket: namngivna importer känns inte igen i Node ESM, så hela modulen importeras.
import zxing from '@zxing/library';

const { BarcodeFormat, QRCodeWriter } = zxing;

const MODULE_PIXELS = 8;

/** QR-matrisen som rader av '1' (mörk modul) och '0', inklusive tyst zon. */
function qrRows(text: string): string[] {
  const matrix = new QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0, new Map());
  return Array.from({ length: matrix.getHeight() }, (_, y) =>
    Array.from({ length: matrix.getWidth() }, (_, x) => (matrix.get(x, y) ? '1' : '0')).join(
      '',
    ),
  );
}

export async function useFakeCameraShowing(page: Page, qrText: string): Promise<void> {
  const rows = qrRows(qrText);
  await page.addInitScript(`
    (() => {
      const rows = ${JSON.stringify(rows)};
      const px = ${MODULE_PIXELS};
      const canvas = document.createElement('canvas');
      canvas.width = rows.length * px;
      canvas.height = rows.length * px;
      const ctx = canvas.getContext('2d');
      function draw() {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#000';
        rows.forEach((row, y) => {
          [...row].forEach((cell, x) => {
            if (cell === '1') ctx.fillRect(x * px, y * px, px, px);
          });
        });
      }
      draw();
      setInterval(draw, 100);
      const stream = canvas.captureStream(15);
      navigator.mediaDevices.getUserMedia = async () => stream;
    })();
  `);
}
