/**
 * 存档出口：「导出」这件事在纯静态站里有个物理边界 ——
 * 用户能不能拿到那个文件，不由我们决定（iOS 分享面板里可能根本没有「存储到文件」）。
 *
 * 所以分三档，每档文案都要说清楚"现在该做什么"，而不是笼统的"不支持"：
 *   ① navigator.share({files})       → 系统面板，最省事
 *   ② navigator.clipboard.writeText  → 复制文本，粘贴到任何地方
 *   ③ blob 下载 + 长按全选文本框      → 兜底，永远可用
 */

export interface ExportResult {
  method: 'share' | 'clipboard' | 'download';
  /** 需要展示给用户手动复制时返回文本 */
  text?: string;
}

function fileName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `eartheno-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}

export async function exportSave(text: string): Promise<ExportResult> {
  const name = fileName();
  // ① 系统分享
  try {
    const file = new File([text], name, { type: 'application/json' });
    const nav = navigator as any;
    if (nav.canShare?.({ files: [file] }) && nav.share) {
      await nav.share({ files: [file], title: '地髓存档' });
      return { method: 'share' };
    }
  } catch (e) {
    // 用户取消分享也会走到这里（AbortError），此时不该继续弹别的
    if ((e as Error)?.name === 'AbortError') return { method: 'share' };
  }
  // ② 剪贴板
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return { method: 'clipboard' };
    }
  } catch {
    /* 无剪贴板权限 */
  }
  // ③ 下载 + 文本框兜底
  try {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch {
    /* ignore */
  }
  return { method: 'download', text };
}

/** 读文件（<input type=file>），返回文本 */
export function pickFile(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json,.txt,text/plain';
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    document.body.append(input);
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      input.remove();
      if (!f) return resolve(null);
      resolve(await f.text());
    });
    input.addEventListener('cancel', () => {
      input.remove();
      resolve(null);
    });
    input.click();
  });
}
