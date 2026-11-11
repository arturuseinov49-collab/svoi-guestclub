import QRCode from 'qrcode';

export const guestQrPattern = /^svoi:guest:v1:[A-Za-z0-9_-]{43}$/;

/** The QR is an opaque guest identifier, never a Telegram identity or a URL to open. */
export function guestInput(value: string, allowShortCode = false) {
  const text = value.trim();
  if (guestQrPattern.test(text)) return { type: 'scanGuest', qr: text };
  const code = text.replace(/[\s-]/g, '').toUpperCase();
  if (allowShortCode && /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/.test(code)) return { type: 'addGuest', guestCode: code };
  throw new Error('Это не QR гостя «Своих». Попросите гостя открыть личный QR или введите его код из 8 символов.');
}

export function guestQrDrawing(value: string) {
  if (!guestQrPattern.test(value)) return null;
  const { modules } = QRCode.create(value, { errorCorrectionLevel: 'M' });
  const quiet = 4;
  const runs: { x: number; y: number; width: number }[] = [];
  for (let y = 0; y < modules.size; y++) {
    let x = 0;
    while (x < modules.size) {
      if (!modules.get(y, x)) { x++; continue; }
      const start = x;
      while (x < modules.size && modules.get(y, x)) x++;
      runs.push({ x: start + quiet, y: y + quiet, width: x - start });
    }
  }
  return { size: modules.size + quiet * 2, runs, path: runs.map(run => `M${run.x} ${run.y}h${run.width}v1h-${run.width}z`).join('') };
}
