export type CopyResult = 'copied' | 'manual';

/**
 * The async Clipboard API needs the "clipboard-write" permission, which Genesys Cloud
 * only grants when configured in the iframe permissions policy. Falls back to
 * execCommand and finally to selecting the text for a manual Ctrl/Cmd+C.
 */
export async function copyText(text: string, fallbackInput?: HTMLInputElement | null): Promise<CopyResult> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return 'copied';
    }
  } catch {
    // permission denied inside the iframe -> fall through
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.className = 'offscreen';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) return 'copied';
  } catch {
    // ignore
  }
  if (fallbackInput) {
    fallbackInput.focus();
    fallbackInput.select();
  }
  return 'manual';
}
